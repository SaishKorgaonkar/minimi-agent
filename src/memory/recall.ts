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
      const ranked = await rankItems(opts.query, { start, end, k: RANGE_LIMIT });
      const keep = new Set(ranked);
      exchanges = exchanges.filter((e) => keep.has(e.userTurnId));
    }
    if (!exchanges.length) {
      return { mode: 'range', range: opts.range, exchanges: [], facts: new Map(), nearest: nearestExchanges(start, end) };
    }
    return { mode: 'range', range: opts.range, exchanges, facts: factsFor(exchanges) };
  }

  const ids = await rankItems(opts.query, { k: opts.semanticK ?? 4, maxDistance: 0.62 });
  const exchanges = exchangesByUserTurnIds(ids)
    .filter((e) => e.userTurnId !== opts.excludeTurnId && !opts.alreadyInContext?.has(e.userTurnId));
  return { mode: exchanges.length ? 'semantic' : 'none', exchanges, facts: factsFor(exchanges) };
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
async function rankItems(query: string, opts: { start?: number; end?: number; k: number; maxDistance?: number }): Promise<string[]> {
  const db = getDb();
  const start = opts.start ?? 0;
  const end = opts.end ?? Number.MAX_SAFE_INTEGER;

  // Keyword side (FTS5 / bm25).
  const ftsQuery = toFtsQuery(query);
  const keyword = ftsQuery
    ? (db.prepare(`SELECT m.turn_id AS turnId FROM memory_fts f JOIN memory_items m ON m.id = f.rowid
                   WHERE memory_fts MATCH ? AND m.created_at >= ? AND m.created_at < ?
                   ORDER BY bm25(memory_fts) LIMIT 40`).all(ftsQuery, start, end) as { turnId: string }[])
    : [];

  // Meaning side (embeddings). Brute-force cosine: fine for one person's history;
  // a vec0 ANN index is the step for larger stores.
  let semantic: { turnId: string; d: number }[] = [];
  try {
    const q = Float32Array.from(await embedText(query));
    if (vectorExtension) {
      semantic = db.prepare(`SELECT turn_id AS turnId, vec_distance_cosine(embedding, ?) AS d FROM memory_items
                             WHERE embedding IS NOT NULL AND created_at >= ? AND created_at < ?
                             ORDER BY d ASC LIMIT 40`).all(toBlob(q), start, end) as { turnId: string; d: number }[];
    } else {
      const rows = db.prepare(`SELECT turn_id AS turnId, embedding FROM memory_items
                               WHERE embedding IS NOT NULL AND created_at >= ? AND created_at < ?`).all(start, end) as { turnId: string; embedding: Buffer }[];
      semantic = rows.map((r) => ({ turnId: r.turnId, d: cosineDistance(q, fromBlob(r.embedding)) })).sort((a, b) => a.d - b.d).slice(0, 40);
    }
    if (opts.maxDistance !== undefined) semantic = semantic.filter((s) => s.d <= opts.maxDistance!);
  } catch {
    // Embedding unavailable: keyword ranking alone still works.
  }

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
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, opts.k).map(([turnId]) => turnId);
}

const FTS_STOP = new Set(['what', 'did', 'you', 'ask', 'asked', 'tell', 'told', 'about', 'the', 'and', 'for', 'was', 'were', 'any', 'has', 'have', 'since', 'then', 'that', 'this', 'with', 'still', 'correct', 'today', 'answer', 'your', 'our', 'we', 'me', 'my', 'is', 'are', 'of', 'on', 'in', 'to', 'a', 'an', 'it', 'its', 'or', 'last', 'remember', 'changed', 'change', 'anything', 'something']);

function toFtsQuery(q: string): string {
  const terms = (q.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2 && !FTS_STOP.has(t));
  return [...new Set(terms)].slice(0, 12).map((t) => `"${t}"`).join(' OR ');
}
