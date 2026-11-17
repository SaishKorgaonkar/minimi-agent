import { config } from '../config.js';
import { now } from '../clock.js';
import type { RawResult, SearchProvider, SearchQuery } from './types.js';

/**
 * One adapter per provider, same interface. Providers are switched on by which
 * keys exist in .env, so the agent runs with one and gets better with two.
 */

async function postJson(url: string, body: unknown, headers: Record<string, string>, signal: AbortSignal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw new Error(`${url} → ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<any>;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

export const exa: SearchProvider = {
  name: 'exa',
  async search(q: SearchQuery, signal) {
    const body: Record<string, unknown> = {
      query: q.query,
      type: config.search.exaType,
      numResults: q.maxResults ?? config.search.resultsPerProvider,
      contents: {
        text: { maxCharacters: 4000 },
        highlights: { maxCharacters: 1200, query: q.query },
        ...(q.fresh ? { maxAgeHours: 24 } : {}),
      },
    };
    if (q.topic === 'news') body.category = 'news';
    if (q.after) body.startPublishedDate = q.after.toISOString();
    if (q.before) body.endPublishedDate = q.before.toISOString();
    const data = await postJson('https://api.exa.ai/search', body, { 'x-api-key': config.keys.exa }, signal);
    return (data.results ?? []).map((r: any, i: number): RawResult => ({
      url: r.url,
      title: r.title ?? r.url,
      snippet: (r.highlights ?? []).join(' … ') || (r.text ?? '').slice(0, 400),
      text: r.text,
      publishedAt: r.publishedDate ?? null,
      provider: 'exa',
      rank: i,
    }));
  },
};

export const tavily: SearchProvider = {
  name: 'tavily',
  async search(q, signal) {
    const body: Record<string, unknown> = {
      query: q.query,
      search_depth: 'basic',
      topic: q.topic ?? 'general',
      max_results: q.maxResults ?? config.search.resultsPerProvider,
      chunks_per_source: 3,
      include_published_date: true,
    };
    if (q.after) body.start_date = ymd(q.after);
    if (q.before) body.end_date = ymd(q.before);
    const data = await postJson('https://api.tavily.com/search', body, { authorization: `Bearer ${config.keys.tavily}` }, signal);
    return (data.results ?? []).map((r: any, i: number): RawResult => ({
      url: r.url,
      title: r.title ?? r.url,
      snippet: r.content ?? '',
      publishedAt: r.published_date ?? null,
      provider: 'tavily',
      rank: i,
    }));
  },
};

export const brave: SearchProvider = {
  name: 'brave',
  async search(q, signal) {
    const params = new URLSearchParams({
      q: q.query,
      count: String(q.maxResults ?? config.search.resultsPerProvider),
      extra_snippets: 'true',
    });
    if (q.after) params.set('freshness', `${ymd(q.after)}to${ymd(q.before ?? now())}`);
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
      headers: { accept: 'application/json', 'x-subscription-token': config.keys.brave },
      signal,
    });
    if (!res.ok) throw new Error(`brave → ${res.status}`);
    const data = (await res.json()) as any;
    return (data.web?.results ?? []).map((r: any, i: number): RawResult => ({
      url: r.url,
      title: stripTags(r.title ?? r.url),
      snippet: stripTags([r.description, ...(r.extra_snippets ?? [])].filter(Boolean).join(' … ')),
      publishedAt: r.page_age ?? null,
      provider: 'brave',
      rank: i,
    }));
  },
};

function stripTags(s: string) {
  return s.replace(/<[^>]+>/g, '');
}

let testProviders: SearchProvider[] | null = null;
/** Test seam: replace the real providers. */
export function setTestProviders(p: SearchProvider[] | null) {
  testProviders = p;
}

export function enabledProviders(): SearchProvider[] {
  if (testProviders) return testProviders;
  const all: [SearchProvider, string][] = [[exa, config.keys.exa], [tavily, config.keys.tavily], [brave, config.keys.brave]];
  const only = process.env.SEARCH_PROVIDERS?.split(',').map((s) => s.trim()).filter(Boolean);
  return all.filter(([p, key]) => key && (!only || only.includes(p.name))).map(([p]) => p);
}

export const allProviders = { exa, tavily, brave };
