import { config } from '../config.js';
import { nowMs } from '../clock.js';
import { log } from '../log.js';
import { bestPassages, fetchPage } from './fetch.js';
import { enabledProviders } from './providers.js';
import type { Evidence, RawResult, SearchProvider, SearchQuery } from './types.js';

/**
 * The search pipeline behind the agent's single `web_search` tool:
 *
 *   query variants × providers (in parallel, time-capped)
 *     → merge (normalise URLs, reciprocal rank fusion, recency boost, domain cap)
 *     → fetch pages the providers gave no text for
 *     → relevant passages, numbered for citation
 */

/** Stable [n] numbering for every source seen during one turn. */
export class SourceRegistry {
  private byUrl = new Map<string, Evidence>();

  add(e: Omit<Evidence, 'n'>): Evidence {
    const key = normaliseUrl(e.url);
    const existing = this.byUrl.get(key);
    if (existing) {
      for (const p of e.passages) if (!existing.passages.includes(p)) existing.passages.push(p);
      existing.passages = existing.passages.slice(0, 4);
      return existing;
    }
    const ev = { ...e, n: this.byUrl.size + 1 };
    this.byUrl.set(key, ev);
    return ev;
  }

  all(): Evidence[] {
    return [...this.byUrl.values()];
  }

  get(n: number): Evidence | undefined {
    return this.all().find((e) => e.n === n);
  }
}

export interface SearchRun {
  evidence: Evidence[];
  stats: {
    queries: string[];
    providers: Record<string, { ok: boolean; ms: number; results: number; error?: string }>;
    fetched: number;
    ms: number;
  };
}

export async function webSearch(
  input: { queries: string[]; after?: Date; before?: Date; topic?: 'general' | 'news'; fresh?: boolean; maxResults?: number },
  registry: SourceRegistry,
  providers: SearchProvider[] = enabledProviders(),
): Promise<SearchRun> {
  const t0 = performance.now();
  const queries = [...new Set(input.queries.map((q) => q.trim()).filter(Boolean))].slice(0, 3);
  const stats: SearchRun['stats'] = { queries, providers: {}, fetched: 0, ms: 0 };
  if (!providers.length || !queries.length) return { evidence: [], stats };

  // 1. Fan out: every query to every provider, all at once, under one deadline.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), config.search.providerTimeoutMs);
  const lists: RawResult[][] = [];
  await Promise.all(
    providers.flatMap((p) =>
      queries.map(async (query) => {
        const s = performance.now();
        const key = `${p.name}:${query.slice(0, 40)}`;
        try {
          const q: SearchQuery = { query, after: input.after, before: input.before, topic: input.topic, fresh: input.fresh };
          const results = await p.search(q, controller.signal);
          lists.push(results);
          stats.providers[key] = { ok: true, ms: Math.round(performance.now() - s), results: results.length };
        } catch (err) {
          stats.providers[key] = { ok: false, ms: Math.round(performance.now() - s), results: 0, error: String((err as Error).message ?? err).slice(0, 160) };
        }
      }),
    ),
  );
  clearTimeout(deadline);
  if (!lists.length) log.warn({ stats }, 'all search providers failed or timed out');

  // 2. Merge.
  const merged = fuse(lists, { after: input.after, maxResults: input.maxResults ?? config.search.maxResults });

  // 3. Fetch full pages only where the provider returned no usable text.
  const needFetch = merged.filter((m) => !m.text || m.text.length < 500).slice(0, config.search.maxFetch);
  const pages = await Promise.all(needFetch.map((m) => fetchPage(m.url)));
  needFetch.forEach((m, i) => {
    if (pages[i]) { m.text = pages[i]!.text; stats.fetched++; }
  });

  // 4. Passages relevant to the queries, registered for citation.
  const queryText = queries.join(' ');
  const fetchedAt = nowMs();
  const evidence = merged.map((m) => {
    const passages = m.text ? bestPassages(m.text, queryText, 2) : [];
    if (m.snippet && !passages.some((p) => p.includes(m.snippet.slice(0, 60)))) passages.unshift(m.snippet.slice(0, 700));
    return registry.add({
      url: m.url,
      title: m.title,
      publishedAt: m.publishedAt ?? null,
      fetchedAt,
      passages: passages.filter(Boolean).slice(0, 3),
      foundBy: m.foundBy,
    });
  });

  stats.ms = Math.round(performance.now() - t0);
  return { evidence, stats };
}

interface Merged extends RawResult { score: number; foundBy: string[] }

/**
 * Reciprocal rank fusion across all (provider × query) lists. A page found by
 * several lists scores higher. Inside a date window, dated pages get a boost.
 * At most two results per domain so one site can't crowd out the rest.
 */
export function fuse(lists: RawResult[][], opts: { after?: Date; maxResults: number }): Merged[] {
  const K = 60;
  const byUrl = new Map<string, Merged>();
  for (const list of lists) {
    for (const r of list) {
      if (!r.url || !/^https?:/.test(r.url)) continue;
      const key = normaliseUrl(r.url);
      const contribution = 1 / (K + r.rank + 1);
      const m = byUrl.get(key);
      if (m) {
        m.score += contribution;
        if (!m.foundBy.includes(r.provider)) m.foundBy.push(r.provider);
        if ((r.text?.length ?? 0) > (m.text?.length ?? 0)) m.text = r.text;
        if (!m.publishedAt && r.publishedAt) m.publishedAt = r.publishedAt;
        if (r.snippet.length > m.snippet.length) m.snippet = r.snippet;
      } else {
        byUrl.set(key, { ...r, score: contribution, foundBy: [r.provider] });
      }
    }
  }
  const items = [...byUrl.values()];
  if (opts.after) {
    for (const m of items) {
      const t = m.publishedAt ? Date.parse(m.publishedAt) : NaN;
      if (Number.isFinite(t) && t >= opts.after.getTime()) m.score *= 1.25;
    }
  }
  items.sort((a, b) => b.score - a.score);
  const perDomain = new Map<string, number>();
  const out: Merged[] = [];
  for (const m of items) {
    const d = domain(m.url);
    const n = perDomain.get(d) ?? 0;
    if (n >= 2) continue;
    perDomain.set(d, n + 1);
    out.push(m);
    if (out.length >= opts.maxResults) break;
  }
  return out;
}

export function normaliseUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = '';
    for (const p of [...url.searchParams.keys()]) if (/^(utm_|ref$|fbclid|gclid)/.test(p)) url.searchParams.delete(p);
    const host = url.hostname.replace(/^www\./, '');
    const path = url.pathname.replace(/\/+$/, '');
    const qs = url.searchParams.toString();
    return `${host}${path}${qs ? `?${qs}` : ''}`.toLowerCase();
  } catch {
    return u.toLowerCase();
  }
}

export function domain(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
}

/** How evidence is shown to the model. */
export function formatEvidence(evidence: Evidence[]): string {
  if (!evidence.length) return 'No results.';
  return evidence
    .map((e) => {
      const date = e.publishedAt ? `published ${e.publishedAt.slice(0, 10)}` : 'publish date unknown';
      return `[${e.n}] ${e.title}\n${e.url} (${date})\n${e.passages.map((p) => `> ${p.replace(/\n+/g, ' ')}`).join('\n')}`;
    })
    .join('\n\n');
}
