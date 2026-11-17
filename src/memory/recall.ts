import { getDb, vectorExtension } from '../db/index.js';
import { exchangesByUserTurnIds, exchangesInRange, nearestExchanges, type Exchange } from '../db/repo.js';
import { embedText } from '../llm.js';
import type { DateRange } from '../time/resolve.js';
import { cosineDistance, fromBlob, toBlob } from '../util.js';

/**
 * Memory recall. Two modes:
 *
 *  - With a date range ("on 3 Nov", "last Tuesday"): the range is the filter.
 *    Every exchange in it is a candidate; we rank only if there are too many.
 *    "What did I ask on 3 Nov?" has almost no word overlap with the answer, so
 *    relevance ranking alone would miss it. Time filtering is the point.
 *  - Without a range: hybrid search over all past turns and extracted facts
 *    (FTS5 keyword rank + embedding similarity, merged by reciprocal rank fusion).
 */

export interface RecallResult {
  mode: 'range' | 'semantic' | 'none';
  range?: DateRange;
  exchanges: Exchange[];
  /** Facts extracted from the recalled exchanges. */
  facts: Map<string, string[]>;
  /** When a range had nothing: the nearest exchanges on either side. */
  nearest?: { before?: Exchange; after?: Exchange };
  /** Semantic mode: each exchange's closest cosine distance to the query (lower = closer). */
  distance?: Map<string, number>;
}

/**
 * For a question about the world (search or chat), only keep memory that is
 * strongly related by meaning: a game-price question shouldn't surface a CRM
 * chat just because both say "latest pricing". Keyword matches stay for
 * questions about our past conversations ("Did I ever ask about Render?").
 */
export const STRONG_DISTANCE = 0.5;

export function strongOnly(r: RecallResult): RecallResult {
  if (r.mode !== 'semantic' || !r.distance) return r;
  const exchanges = r.exchanges.filter((e) => (r.distance!.get(e.userTurnId) ?? Infinity) <= STRONG_DISTANCE);
  const keep = new Set(exchanges.map((e) => e.userTurnId));
  return { ...r, mode: exchanges.length ? 'semantic' : 'none', exchanges, facts: new Map([...r.facts].filter(([id]) => keep.has(id))) };
}

const RANGE_LIMIT = 12;

export async function recall(opts: {
  query: string;
  range: DateRange | null;
  /** The current question. */
  excludeTurnId?: string;
  /** Turns already in the prompt as recent conversation; don't repeat them. */
  alreadyInContext?: Set<string>;
  semanticK?: number;
}): Promise<RecallResult> {
  if (opts.range) {
    const start = opts.range.start.getTime();
    const end = opts.range.end.getTime();
    let exchanges = exchangesInRange(start, end, 200, opts.excludeTurnId);
    if (exchanges.length > RANGE_LIMIT) {
      const { ids: ranked } = await rankItems(opts.query, { start, end, k: RANGE_LIMIT });
      const keep = new Set(ranked);
      exchanges = exchanges.filter((e) => keep.has(e.userTurnId));
    }
    if (!exchanges.length) {
      return { mode: 'range', range: opts.range, exchanges: [], facts: new Map(), nearest: nearestExchanges(start, end) };
    }
    return { mode: 'range', range: opts.range, exchanges, facts: factsFor(exchanges) };
  }

  // Rank one extra so excluding the current question still leaves k.
  const { ids, distance } = await rankItems(opts.query, { k: (opts.semanticK ?? 4) + 1, maxDistance: 0.55, exclude: opts.excludeTurnId });
  const exchanges = exchangesByUserTurnIds(ids)
    .filter((e) => e.userTurnId !== opts.excludeTurnId && !opts.alreadyInContext?.has(e.userTurnId))
    .slice(0, opts.semanticK ?? 4);
  return { mode: exchanges.length ? 'semantic' : 'none', exchanges, facts: factsFor(exchanges), distance };
}

function factsFor(exchanges: Exchange[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!exchanges.length) return out;
  const marks = exchanges.map(() => '?').join(',');
  const rows = getDb()
    .prepare(`SELECT turn_id, text FROM memory_items WHERE kind = 'fact' AND turn_id IN (${marks}) ORDER BY id`)
    .all(...exchanges.map((e) => e.userTurnId)) as { turn_id: string; text: string }[];
  for (const r of rows) out.set(r.turn_id, [...(out.get(r.turn_id) ?? []), r.text]);
  return out;
}

/**
 * Hybrid ranking over memory_items, optionally inside a time window.
 * Returns user-turn ids (exchange keys), best first.
 */
/**
 * Hybrid ranking with relevance floors, so an unrelated question shows no
 * "related" memory. Measured on real history: related exchanges sit at cosine
 * distance 0.37–0.51 and unrelated ones above 0.6. Keyword matches catch names
 * the embedding misses ("Did I ever ask about Render?" is 0.70 by meaning), but
 * only for words that are uncommon in the history, and only if the meaning
 * isn't far off. Common words like "latest" or "pricing" alone no longer recall
 * a CRM chat for a video-game question.
 */
const KEYWORD_MAX_DISTANCE = 0.75;
const COMMON_TERM_SHARE = 0.15;

async function rankItems(
  query: string, opts: { start?: number; end?: number; k: number; maxDistance?: number; exclude?: string },
): Promise<{ ids: string[]; distance: Map<string, number> }> {
  const db = getDb();
  const start = opts.start ?? 0;
  const end = opts.end ?? Number.MAX_SAFE_INTEGER;

  // Meaning side: distance of every item in the window (brute force is fine for
  // one person's history; a vec0 ANN index is the step for larger stores).
  const best = new Map<string, number>();
  let embedded = false;
  try {
    const q = Float32Array.from(await embedText(query));
    const rows = vectorExtension
      ? (db.prepare(`SELECT turn_id AS turnId, vec_distance_cosine(embedding, ?) AS d FROM memory_items
                     WHERE embedding IS NOT NULL AND created_at >= ? AND created_at < ?`).all(toBlob(q), start, end) as { turnId: string; d: number }[])
      : (db.prepare(`SELECT turn_id AS turnId, embedding FROM memory_items
                     WHERE embedding IS NOT NULL AND created_at >= ? AND created_at < ?`).all(start, end) as { turnId: string; embedding: Buffer }[])
          .map((r) => ({ turnId: r.turnId, d: cosineDistance(q, fromBlob(r.embedding)) }));
    for (const r of rows) if (r.turnId !== opts.exclude) best.set(r.turnId, Math.min(best.get(r.turnId) ?? Infinity, r.d));
    embedded = true;
  } catch {
    // Embedding unavailable: keyword ranking alone still works.
  }
  const semantic = [...best.entries()]
    .filter(([, d]) => opts.maxDistance === undefined || d <= opts.maxDistance)
    .sort((a, b) => a[1] - b[1]).slice(0, 40).map(([turnId]) => ({ turnId }));

  // Keyword side: FTS5 on the query's uncommon words only.
  const ftsQuery = toFtsQuery(query, rareTerms(db, query, start, end));
  const keyword = ftsQuery
    ? (db.prepare(`SELECT m.turn_id AS turnId FROM memory_fts f JOIN memory_items m ON m.id = f.rowid
                   WHERE memory_fts MATCH ? AND m.created_at >= ? AND m.created_at < ?
                   ORDER BY bm25(memory_fts) LIMIT 40`).all(ftsQuery, start, end) as { turnId: string }[])
        .filter((k) => k.turnId !== opts.exclude && (!embedded || (best.get(k.turnId) ?? Infinity) <= KEYWORD_MAX_DISTANCE))
    : [];

  const scores = new Map<string, number>();
  const add = (list: { turnId: string }[], weight: number) => {
    const seen = new Set<string>();
    list.forEach((item, rank) => {
      if (seen.has(item.turnId)) return; // first (best) item per exchange counts
      seen.add(item.turnId);
      scores.set(item.turnId, (scores.get(item.turnId) ?? 0) + weight / (60 + rank + 1));
    });
  };
  add(keyword, 1);
  add(semantic, 1);
  const ids = [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.k).map(([turnId]) => turnId);
  return { ids, distance: best };
}

/** Query words that appear in at most 15% of memory items (all words while the history is tiny). */
function rareTerms(db: ReturnType<typeof getDb>, query: string, start: number, end: number): Set<string> {
  const terms = queryTerms(query);
  const total = (db.prepare('SELECT COUNT(*) AS n FROM memory_items WHERE created_at >= ? AND created_at < ?').get(start, end) as { n: number }).n;
  if (total < 20) return new Set(terms);
  const count = db.prepare(`SELECT COUNT(*) AS n FROM memory_fts f JOIN memory_items m ON m.id = f.rowid
                            WHERE memory_fts MATCH ? AND m.created_at >= ? AND m.created_at < ?`);
  return new Set(terms.filter((t) => (count.get(`"${t}"`, start, end) as { n: number }).n / total <= COMMON_TERM_SHARE));
}

const FTS_STOP = new Set(['what', 'did', 'you', 'ask', 'asked', 'tell', 'told', 'about', 'the', 'and', 'for', 'was', 'were', 'any', 'has', 'have', 'since', 'then', 'that', 'this', 'with', 'still', 'correct', 'today', 'answer', 'your', 'our', 'we', 'me', 'my', 'is', 'are', 'of', 'on', 'in', 'to', 'a', 'an', 'it', 'its', 'or', 'last', 'remember', 'changed', 'change', 'anything', 'something']);

function queryTerms(q: string): string[] {
  return [...new Set((q.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2 && !FTS_STOP.has(t)))].slice(0, 12);
}

function toFtsQuery(q: string, keep?: Set<string>): string {
  return queryTerms(q).filter((t) => !keep || keep.has(t)).map((t) => `"${t}"`).join(' OR ');
}
