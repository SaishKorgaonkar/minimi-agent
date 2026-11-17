import { generateText, Output } from 'ai';
import { z } from 'zod';
import { nowMs } from '../clock.js';
import { config } from '../config.js';
import {
  insertClaim, insertSnapshot, insertVerification, latestSnapshot, supersedeClaim, type Claim,
} from '../db/repo.js';
import { models, withOptionsFallback } from '../llm.js';
import { log } from '../log.js';
import { bestPassages, fetchPage } from '../search/fetch.js';
import { formatEvidence, webSearch, type SourceRegistry } from '../search/index.js';
import type { Evidence } from '../search/types.js';
import { prompt } from '../prompts.js';
import { isoDay } from '../time/tz.js';

/**
 * Re-check stored claims against today's web. For each entity (gathered in
 * parallel, then judged together in one call):
 *
 *  1. Re-fetch the page the claim came from and compare it with the snapshot
 *     taken when the claim was made. Same hash → unchanged, no LLM needed.
 *  2. Search for news about the entity published since the claim was made
 *     (pricing pages often change without a new "published" date, so (1) matters).
 *  3. One structured judge call compares old values with the new evidence.
 *
 * Every outcome is recorded in `verifications`; a changed claim gets a new
 * version and the old one is marked superseded (never deleted).
 */

export type Status = 'changed' | 'unchanged' | 'unverified';

export interface VerifiedClaim {
  claim: Claim;
  status: Status;
  newValue: string | null;
  evidence: number[];
  note: string | null;
}

export interface EntityReport {
  entity: string;
  claims: VerifiedClaim[];
  /** Notable news since then ("shipped something big"). */
  news: { summary: string; evidence: number[] }[];
}

const verdictSchema = z.object({
  index: z.number().describe('Index of the claim within its entity'),
  status: z.enum(['changed', 'unchanged', 'unverified']).describe(
    'changed: the new evidence clearly shows a different current value. unchanged: the evidence clearly shows the same value. unverified: the evidence does not settle it.',
  ),
  currentValue: z.string().nullable().describe('The current value if the evidence shows it'),
  evidence: z.array(z.number()).describe('Source numbers [n] that support the verdict'),
  note: z.string().nullable().describe('One short sentence, e.g. "Plan renamed from Pro to Scale"'),
});

const judgeSchema = z.object({
  entities: z.array(z.object({
    entity: z.number().describe('Entity number from the ## heading'),
    claims: z.array(verdictSchema),
    news: z.array(z.object({
      summary: z.string().describe('One sentence: a notable launch, pricing change, acquisition or shutdown since the date'),
      evidence: z.array(z.number()),
    })).describe('Only significant, dated news after the since-date. Empty if none.'),
  })),
});

const MAX_ENTITIES = 6;

/**
 * Re-check claims, grouped by vendor. Evidence is gathered for every vendor in
 * parallel, then ONE judge call decides all of them: concurrent judge calls
 * were measured being processed one at a time by the API (~3 s each), so five
 * vendors took ~17 s; a single batched call takes a few seconds.
 */
export async function verifyClaims(
  claims: Claim[],
  since: Date,
  registry: SourceRegistry,
  onProgress?: (msg: string) => void,
  tz = config.timezone,
): Promise<EntityReport[]> {
  // Group by vendor: "HubSpot Sales Hub Starter" and "HubSpot Sales Hub
  // Professional" are one check, so five shortlisted CRMs are five groups.
  const byEntity = new Map<string, Claim[]>();
  for (const c of claims) {
    const key = vendorKey(c.entity);
    byEntity.set(key, [...(byEntity.get(key) ?? []), c]);
  }
  const groups = [...byEntity.values()].slice(0, MAX_ENTITIES).map((g) => g.slice(0, 8));
  if (!groups.length) return [];
  onProgress?.(`Re-checking ${groups.length} ${groups.length === 1 ? 'item' : 'items'} against today's web`);

  const checkedAt = nowMs();
  const t0 = performance.now();
  const gathered = await Promise.all(groups.map((g) => gather(g, since, registry, checkedAt)));
  const gatheredMs = Math.round(performance.now() - t0);
  await judge(gathered, since, registry, checkedAt, tz);
  log.debug({ entities: gathered.length, gatheredMs, totalMs: Math.round(performance.now() - t0) }, 'claims verified');

  return gathered.map((g) => {
    record(g.results, registry, checkedAt);
    return { entity: g.entity, claims: g.results, news: g.news };
  });
}

export function vendorKey(entity: string): string {
  return entity.trim().toLowerCase().split(/\s+/)[0] ?? '';
}

/** The shared leading words of a group's entity names: the vendor or product line. */
export function groupLabel(entities: string[]): string {
  const split = entities.map((e) => e.trim().split(/\s+/));
  const out: string[] = [];
  for (let i = 0; i < split[0].length; i++) {
    const w = split[0][i];
    if (!split.every((s) => s[i]?.toLowerCase() === w.toLowerCase())) break;
    out.push(w);
  }
  return out.join(' ') || split[0][0];
}

interface Gathered {
  entity: string;
  results: VerifiedClaim[];
  /** Claims the judge must decide (not settled by an identical page). */
  needJudge: VerifiedClaim[];
  evidence: Evidence[];
  news: EntityReport['news'];
}

/** Re-fetch the claims' source pages and search for current state and news, in parallel. */
async function gather(claims: Claim[], since: Date, registry: SourceRegistry, checkedAt: number): Promise<Gathered> {
  const entity = groupLabel([...new Set(claims.map((c) => c.entity))]);
  const attributes = [...new Set(claims.map((c) => c.attribute))].slice(0, 3).join(', ');
  const urls = [...new Set(claims.map((c) => c.source_url).filter((u): u is string => !!u))].slice(0, 2);

  const [pages, found] = await Promise.all([
    Promise.all(urls.map(async (url) => {
      const page = await fetchPage(url);
      const claimTime = Math.min(...claims.filter((c) => c.source_url === url).map((c) => c.checked_at));
      // The snapshot taken when the claim was made (allow a day for the background job).
      const before = latestSnapshot(url, claimTime + 86_400_000);
      if (page) insertSnapshot({ url, fetched_at: checkedAt, content_hash: page.hash, title: page.title, text: page.text });
      return { url, page, sameAsBefore: !!(page && before && before.content_hash === page.hash) };
    })),
    // Current state (no date filter: pricing pages rarely carry a new publish
    // date) and news since the earlier answer.
    Promise.all([
      webSearch({ queries: [`${entity} ${claims[0].attribute}`], maxResults: 3, deadlineMs: config.search.verifyTimeoutMs }, registry),
      webSearch({ queries: [`${entity} news announcement`], after: since, topic: 'news', maxResults: 3, deadlineMs: config.search.verifyTimeoutMs }, registry),
    ]).then(([current, recent]) => [...current.evidence, ...recent.evidence]).catch((err) => {
      log.warn({ err: String(err), entity }, 'verification search failed');
      return [] as Evidence[];
    }),
  ]);

  const evidence: Evidence[] = [...found];
  for (const p of pages) {
    if (!p.page) continue;
    evidence.unshift(registry.add({
      url: p.url, title: `${p.page.title} (re-fetched today)`, publishedAt: null, fetchedAt: checkedAt,
      passages: bestPassages(p.page.text, `${entity} ${attributes} ${claims.map((c) => c.value).join(' ')}`, 3),
      foundBy: ['refetch'],
    }));
  }

  // Fast path: a claim whose source page is (normalised) identical needs no judge.
  const unchangedUrls = new Set(pages.filter((p) => p.sameAsBefore).map((p) => p.url));
  const results: VerifiedClaim[] = claims.map((claim) => ({ claim, status: 'unverified', newValue: null, evidence: [], note: null }));
  const needJudge = results.filter((r) => !(r.claim.source_url && unchangedUrls.has(r.claim.source_url)));
  for (const r of results) {
    if (needJudge.includes(r)) continue;
    r.status = 'unchanged';
    r.note = 'Source page identical to when this was first answered';
    const ev = evidence.find((e) => e.url === r.claim.source_url);
    if (ev) r.evidence = [ev.n];
  }
  return { entity, results, needJudge, evidence: dedupe(evidence), news: [] };
}

function dedupe(evidence: Evidence[]): Evidence[] {
  const seen = new Set<number>();
  return evidence.filter((e) => !seen.has(e.n) && seen.add(e.n));
}

/** What the judge sees for one entity. */
export interface JudgeItem {
  entity: string;
  claims: Pick<Claim, 'entity' | 'attribute' | 'value' | 'checked_at' | 'source_url'>[];
  evidence: Evidence[];
}

export type JudgeOutput = z.infer<typeof judgeSchema>;

/**
 * The judge call itself, shared by production and `npm run optimize`.
 * Entities are numbered by their position in `items`.
 */
export async function judgeClaims(
  items: JudgeItem[], since: Date, today: Date, tz: string, instructions = prompt('judge'),
): Promise<JudgeOutput | undefined> {
  const sections = items.map((g, i) => {
    const list = g.claims.map((c, k) =>
      // Each claim keeps its own product name: grouped under "Pipedrive", a bare
      // "price per seat: $39" (Growth) would be compared with Lite's $14.
      `${k}. ${c.entity}, ${c.attribute}: "${c.value}" (stated ${isoDay(new Date(c.checked_at), tz)}${c.source_url ? `, source ${c.source_url}` : ''})`).join('\n');
    return `## ${i}. Entity: ${g.entity}\nEARLIER CLAIMS:\n${list || '(none to judge; only report news)'}\n\nEVIDENCE:\n${formatEvidence(g.evidence)}`;
  });
  const { output } = await withOptionsFallback('judge', (providerOptions) =>
    generateText({
      model: models.judge(),
      providerOptions,
      output: Output.object({ schema: judgeSchema }),
      instructions,
      prompt: `Since: ${isoDay(since, tz)}\nToday: ${isoDay(today, tz)}\n\n${sections.join('\n\n')}`,
    }),
  );
  return output;
}

/** One structured call decides every entity's open claims and notable news. */
async function judge(groups: Gathered[], since: Date, registry: SourceRegistry, checkedAt: number, tz: string) {
  const open = groups.filter((g) => g.evidence.length);
  if (!open.length) return;
  try {
    const output = await judgeClaims(
      open.map((g) => ({ entity: g.entity, claims: g.needJudge.map((r) => r.claim), evidence: g.evidence })),
      since, new Date(checkedAt), tz,
    );
    for (const e of output?.entities ?? []) {
      const g = open[e.entity];
      if (!g) continue;
      for (const v of e.claims) {
        const r = g.needJudge[v.index];
        if (!r) continue;
        r.status = v.status;
        r.newValue = v.status === 'changed' ? v.currentValue : null;
        r.evidence = v.evidence.filter((n) => registry.get(n));
        r.note = v.note;
      }
      g.news = e.news.slice(0, 3).map((n) => ({ summary: n.summary, evidence: n.evidence.filter((x) => registry.get(x)) }));
    }
  } catch (err) {
    log.warn({ err: String(err) }, 'verification judge failed; claims stay unverified');
  }
}

/** Record every outcome; a changed claim gets a new version and the old one is superseded. */
function record(results: VerifiedClaim[], registry: SourceRegistry, checkedAt: number) {
  for (const r of results) {
    const ev = r.evidence.map((n) => registry.get(n)).filter(Boolean).map((e) => ({ url: e!.url, title: e!.title }));
    insertVerification({ claimId: r.claim.id, status: r.status, newValue: r.newValue, evidence: ev, note: r.note, checkedAt });
    if (r.status === 'changed' && r.newValue && !r.claim.superseded_by) {
      const newId = insertClaim({
        turn_id: r.claim.turn_id, entity: r.claim.entity, attribute: r.claim.attribute, value: r.newValue,
        source_url: ev[0]?.url ?? r.claim.source_url, checked_at: checkedAt,
      });
      supersedeClaim(r.claim.id, newId);
    }
  }
}

/** How a verification report is shown to the answer model. */
export function formatReport(reports: EntityReport[]): string {
  return reports.map((r) => {
    const lines = r.claims.map((c) => {
      const was = `${c.claim.attribute}: was "${c.claim.value}"`;
      const ev = c.evidence.length ? ` [${c.evidence.join('][')}]` : '';
      if (c.status === 'changed') return `- CHANGED ${was} → now "${c.newValue}"${ev}${c.note ? ` (${c.note})` : ''}`;
      if (c.status === 'unchanged') return `- UNCHANGED ${was}${ev}${c.note ? ` (${c.note})` : ''}`;
      return `- COULD NOT VERIFY ${was}${c.note ? ` (${c.note})` : ''}`;
    });
    const news = r.news.map((n) => `- NEWS: ${n.summary}${n.evidence.length ? ` [${n.evidence.join('][')}]` : ''}`);
    return `### ${r.entity}\n${[...lines, ...news].join('\n')}`;
  }).join('\n\n');
}
