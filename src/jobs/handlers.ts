import { config } from '../config.js';
import {
  claimsToRecheck, getTurn, hasMemoryItems, insertClaim, insertMemoryItem, insertNudge, insertSnapshot,
  latestSnapshot, type Source,
} from '../db/repo.js';
import { extractFromExchange } from '../claims/extract.js';
import { verifyClaims } from '../claims/verify.js';
import { embedTexts } from '../llm.js';
import { log } from '../log.js';
import { fetchPage } from '../search/fetch.js';
import { SourceRegistry } from '../search/index.js';
import { formatDay } from '../time/tz.js';
import { json, toBlob, truncate } from '../util.js';
import { enqueue, registerHandler } from './queue.js';

/**
 * Background work that runs after an answer has streamed. Nothing here is on
 * the path to the first token.
 */

interface ExchangePayload { userTurnId: string; assistantTurnId: string }

/** Index the exchange for recall: keyword (FTS5 via trigger) + embedding. */
registerHandler('index_turn', async ({ payload, step }) => {
  const { userTurnId, assistantTurnId } = payload as ExchangePayload;
  if (hasMemoryItems(userTurnId, 'turn')) return;
  const user = getTurn(userTurnId);
  const assistant = getTurn(assistantTurnId);
  if (!user || !assistant) return;
  const text = `Q: ${user.content}\nA: ${truncate(assistant.content, 2500)}`;
  const vectors = await step('embed', () => embedTexts([text]));
  insertMemoryItem({ kind: 'turn', turnId: userTurnId, text, embedding: vectors[0] ? toBlob(vectors[0]) : null, createdAt: user.created_at });
});

/** Extract facts (memory) and claims (checkable statements) from the exchange. */
registerHandler('extract_claims', async ({ payload, step }) => {
  const { userTurnId, assistantTurnId } = payload as ExchangePayload;
  const user = getTurn(userTurnId);
  const assistant = getTurn(assistantTurnId);
  if (!user || !assistant) return;
  const sources = json<Source[]>(assistant.sources, []);

  // Saved as a step: a retry after a crash doesn't pay for extraction twice.
  const extraction = await step('extract', () =>
    extractFromExchange({ question: user.content, answer: assistant.content, sources, at: new Date(user.created_at), tz: user.tz }));

  await step('save_facts', async () => {
    if (hasMemoryItems(userTurnId, 'fact') || !extraction.facts.length) return 0;
    const dayLabel = formatDay(new Date(user.created_at), user.tz, true);
    const texts = extraction.facts.map((f) => `(${dayLabel}) ${f}`);
    const vectors = await embedTexts(texts).catch(() => [] as number[][]);
    texts.forEach((text, i) => insertMemoryItem({
      kind: 'fact', turnId: userTurnId, text, embedding: vectors[i] ? toBlob(vectors[i]) : null, createdAt: user.created_at,
    }));
    return texts.length;
  });

  const claimUrls = await step('save_claims', async () => {
    const urls = new Set<string>();
    for (const c of extraction.claims) {
      const src = c.source ? sources.find((s) => s.n === c.source) : undefined;
      insertClaim({
        turn_id: assistantTurnId, entity: c.entity, attribute: c.attribute, value: c.value,
        source_url: src?.url ?? null, checked_at: assistant.created_at,
      });
      if (src) urls.add(src.url);
    }
    return [...urls];
  });

  if (claimUrls.length) enqueue('snapshot_sources', { urls: claimUrls });
  if (extraction.claims.length && config.jobs.recheckAfterMs > 0) {
    // Scheduled from real time, so backdated (seeded) history doesn't fire immediately.
    enqueue('recheck_claims', { scheduledFor: assistantTurnId }, Math.max(Date.now(), assistant.created_at) + config.jobs.recheckAfterMs);
  }
});

/** Snapshot the pages claims came from, so a later re-check can compare. */
registerHandler('snapshot_sources', async ({ payload }) => {
  const urls = (payload.urls as string[]).slice(0, 8);
  await Promise.all(urls.map(async (url) => {
    const recent = latestSnapshot(url);
    if (recent && Date.now() - recent.fetched_at < 3_600_000) return; // fresh enough
    const page = await fetchPage(url);
    if (page) insertSnapshot({ url, fetched_at: Date.now(), content_hash: page.hash, title: page.title, text: page.text });
  }));
});

/**
 * Proactive re-check: verify claims that haven't been checked recently and
 * nudge the user only if something actually changed. Quiet otherwise.
 */
registerHandler('recheck_claims', async ({ step }) => {
  const due = claimsToRecheck(Date.now() - config.jobs.recheckAfterMs, 12);
  if (!due.length) return;
  const registry = new SourceRegistry();
  const since = new Date(Math.min(...due.map((c) => c.checked_at)));
  const reports = await step('verify', async () => {
    const r = await verifyClaims(due, since, registry, undefined, getTurn(due[0].turn_id)?.tz);
    // Only what the nudge needs (steps must be JSON).
    return r.map((e) => ({
      entity: e.entity,
      changed: e.claims.filter((c) => c.status === 'changed').map((c) => ({
        claimId: c.claim.id, attribute: c.claim.attribute, was: c.claim.value, now: c.newValue,
        evidence: c.evidence.map((n) => registry.get(n)).filter(Boolean).map((s) => ({ url: s!.url, title: s!.title })),
      })),
      news: e.news.map((n) => ({
        summary: n.summary,
        evidence: n.evidence.map((x) => registry.get(x)).filter(Boolean).map((s) => ({ url: s!.url, title: s!.title })),
      })),
    }));
  });
  for (const r of reports) {
    for (const c of r.changed) {
      insertNudge({ claimId: c.claimId, summary: `${r.entity}: ${c.attribute} changed from "${c.was}" to "${c.now}"`, sources: c.evidence, at: Date.now() });
    }
    for (const n of r.news) insertNudge({ claimId: null, summary: `${r.entity}: ${n.summary}`, sources: n.evidence, at: Date.now() });
  }
  log.info({ checked: due.length, nudges: reports.reduce((a, r) => a + r.changed.length + r.news.length, 0) }, 'proactive re-check done');
});
