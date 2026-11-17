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
import { isoDay } from '../time/tz.js';

/**
 * Re-check stored claims against today's web. For each entity, in parallel:
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

const judgeSchema = z.object({
  claims: z.array(z.object({
    index: z.number().describe('Index of the claim in the list'),
    status: z.enum(['changed', 'unchanged', 'unverified']).describe(
      'changed: the new evidence clearly shows a different current value. unchanged: the evidence clearly shows the same value. unverified: the evidence does not settle it.',
    ),
    currentValue: z.string().nullable().describe('The current value if the evidence shows it'),
    evidence: z.array(z.number()).describe('Source numbers [n] that support the verdict'),
    note: z.string().nullable().describe('One short sentence, e.g. "Plan renamed from Pro to Scale"'),
  })),
  news: z.array(z.object({
    summary: z.string().describe('One sentence: a notable launch, pricing change, acquisition or shutdown since the date'),
    evidence: z.array(z.number()),
  })).describe('Only significant, dated news after the since-date. Empty if none.'),
});

const MAX_ENTITIES = 6;

export async function verifyClaims(
  claims: Claim[],
  since: Date,
  registry: SourceRegistry,
  onProgress?: (msg: string) => void,
  tz = config.timezone,
): Promise<EntityReport[]> {
  const byEntity = new Map<string, Claim[]>();
  for (const c of claims) {
    const key = c.entity.trim().toLowerCase();
    byEntity.set(key, [...(byEntity.get(key) ?? []), c]);
  }
  const groups = [...byEntity.values()].slice(0, MAX_ENTITIES);
  onProgress?.(`Re-checking ${groups.length} ${groups.length === 1 ? 'item' : 'items'} against today's web`);
  return Promise.all(groups.map((g) => verifyEntity(g.slice(0, 8), since, registry, tz)));
}

async function verifyEntity(claims: Claim[], since: Date, registry: SourceRegistry, tz: string): Promise<EntityReport> {
  const entity = claims[0].entity;
  const attributes = [...new Set(claims.map((c) => c.attribute))].slice(0, 3).join(', ');
  const checkedAt = nowMs();

  // 1 + 2 in parallel: re-fetch original sources, search for news since then.
  const urls = [...new Set(claims.map((c) => c.source_url).filter((u): u is string => !!u))].slice(0, 2);
  const [pages, news] = await Promise.all([
    Promise.all(urls.map(async (url) => {
      const page = await fetchPage(url);
      const claimTime = Math.min(...claims.filter((c) => c.source_url === url).map((c) => c.checked_at));
      // The snapshot taken when the claim was made (allow a day for the background job).
      const before = latestSnapshot(url, claimTime + 86_400_000);
      if (page) insertSnapshot({ url, fetched_at: checkedAt, content_hash: page.hash, title: page.title, text: page.text });
      return { url, page, sameAsBefore: !!(page && before && before.content_hash === page.hash) };
    })),
    webSearch({
      queries: [`${entity} ${attributes}`, `${entity} news announcement`],
      after: since,
      maxResults: 5,
      fresh: true,
    }, registry).catch((err) => {
      log.warn({ err: String(err), entity }, 'verification search failed');
      return { evidence: [] as Evidence[], stats: null };
    }),
  ]);

  // Fast path: every claim's source page is byte-for-byte (normalised) the same.
  const unchangedUrls = new Set(pages.filter((p) => p.sameAsBefore).map((p) => p.url));
  const evidence: Evidence[] = [...news.evidence];
  for (const p of pages) {
    if (!p.page) continue;
    evidence.unshift(registry.add({
      url: p.url, title: `${p.page.title} (re-fetched today)`, publishedAt: null, fetchedAt: checkedAt,
      passages: bestPassages(p.page.text, `${entity} ${attributes} ${claims.map((c) => c.value).join(' ')}`, 3),
      foundBy: ['refetch'],
    }));
  }

  const results: VerifiedClaim[] = claims.map((claim) => ({ claim, status: 'unverified', newValue: null, evidence: [], note: null }));
  const needJudge = results.filter((r) => !(r.claim.source_url && unchangedUrls.has(r.claim.source_url)));
  for (const r of results) {
    if (!needJudge.includes(r)) {
      r.status = 'unchanged';
      r.note = 'Source page identical to when this was first answered';
      const ev = evidence.find((e) => e.url === r.claim.source_url);
      if (ev) r.evidence = [ev.n];
    }
  }

  let newsItems: EntityReport['news'] = [];
  if (evidence.length) {
    try {
      const list = needJudge.map((r, i) =>
        `${i}. ${r.claim.attribute}: "${r.claim.value}" (stated ${isoDay(new Date(r.claim.checked_at), tz)}${r.claim.source_url ? `, source ${r.claim.source_url}` : ''})`).join('\n');
      const { output } = await withOptionsFallback('extract', (providerOptions) =>
        generateText({
          model: models.extract(),
          providerOptions,
          output: Output.object({ schema: judgeSchema }),
          instructions:
            'You check whether earlier statements about a product are still true, using only the evidence given. ' +
            'Be conservative: mark "changed" only when the evidence clearly shows a different current value, ' +
            '"unchanged" only when it clearly shows the same one, otherwise "unverified". Never use outside knowledge.',
          prompt:
            `Entity: ${entity}\nSince: ${isoDay(since, tz)}\nToday: ${isoDay(new Date(checkedAt), tz)}\n\n` +
            `EARLIER CLAIMS:\n${list || '(none to judge)'}\n\nEVIDENCE:\n${formatEvidence(evidence)}`,
        }),
      );
      for (const v of output?.claims ?? []) {
        const r = needJudge[v.index];
        if (!r) continue;
        r.status = v.status;
        r.newValue = v.status === 'changed' ? v.currentValue : null;
        r.evidence = v.evidence.filter((n) => registry.get(n));
        r.note = v.note;
      }
      newsItems = (output?.news ?? []).slice(0, 3).map((n) => ({ summary: n.summary, evidence: n.evidence.filter((x) => registry.get(x)) }));
    } catch (err) {
      log.warn({ err: String(err), entity }, 'verification judge failed; claims stay unverified');
    }
  }

  // Record every outcome; version changed claims.
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
  return { entity, claims: results, news: newsItems };
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
