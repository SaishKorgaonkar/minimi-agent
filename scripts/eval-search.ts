/**
 * npm run eval:search — compare search providers on what this agent needs most:
 * freshness. No public benchmark measures it, so we do.
 *
 * For each provider separately, every query runs with a date window. We measure:
 *  - latency (p50 / p90)
 *  - dated:      share of results that carry a publish date at all
 *  - in window:  share of dated results that respect the date filter
 *  - relevant:   share of results an LLM judge rates as on-topic (optional: --judge)
 *
 * Output: a table to paste into DESIGN.md, also written to data/eval/search.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { allProviders } from '../src/search/providers.js';
import type { RawResult, SearchProvider } from '../src/search/types.js';

const DAY = 86_400_000;
const queries: { q: string; days: number }[] = [
  { q: 'OpenAI announcement', days: 7 },
  { q: 'Anthropic Claude release', days: 14 },
  { q: 'Postgres hosting pricing change', days: 30 },
  { q: 'Supabase pricing update', days: 30 },
  { q: 'Neon serverless Postgres news', days: 30 },
  { q: 'HubSpot new product launch', days: 30 },
  { q: 'Pipedrive new feature', days: 30 },
  { q: 'Node.js release', days: 30 },
  { q: 'Vercel pricing change', days: 30 },
  { q: 'macOS update released', days: 14 },
];

const keys: Record<string, string> = { exa: config.keys.exa, tavily: config.keys.tavily, brave: config.keys.brave };
const providers = Object.values(allProviders).filter((p) => keys[p.name]);
if (!providers.length) {
  console.error('No search provider keys configured.');
  process.exit(1);
}
const useJudge = process.argv.includes('--judge');

async function judgeRelevance(query: string, results: RawResult[]): Promise<number> {
  if (!results.length) return 0;
  const { generateText, Output } = await import('ai');
  const { z } = await import('zod');
  const { models } = await import('../src/llm.js');
  const { output } = await generateText({
    model: models.router(),
    output: Output.object({ schema: z.object({ relevant: z.array(z.boolean()) }) }),
    prompt: `Query: ${query}\nFor each result, is it about the query (and recent news, not an old evergreen page)?\n\n${results.map((r, i) => `${i}. ${r.title} — ${r.snippet.slice(0, 200)}`).join('\n')}`,
  });
  const flags = output?.relevant ?? [];
  return flags.filter(Boolean).length / results.length;
}

interface Stat { ms: number[]; total: number; dated: number; inWindow: number; relevant: number[]; errors: number }
const stats = new Map<string, Stat>();

for (const p of providers as SearchProvider[]) {
  const s: Stat = { ms: [], total: 0, dated: 0, inWindow: 0, relevant: [], errors: 0 };
  stats.set(p.name, s);
  for (const { q, days } of queries) {
    const after = new Date(Date.now() - days * DAY);
    const t0 = performance.now();
    try {
      const results = await p.search({ query: q, after, maxResults: 8 }, AbortSignal.timeout(10_000));
      s.ms.push(performance.now() - t0);
      s.total += results.length;
      for (const r of results) {
        const t = r.publishedAt ? Date.parse(r.publishedAt) : NaN;
        if (Number.isFinite(t)) {
          s.dated++;
          if (t >= after.getTime() - DAY) s.inWindow++;
        }
      }
      if (useJudge) s.relevant.push(await judgeRelevance(q, results));
      process.stdout.write('.');
    } catch (err) {
      s.errors++;
      process.stdout.write('x');
    }
  }
  process.stdout.write(` ${p.name}\n`);
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]) : 0;
};
const share = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');
const rows = [...stats.entries()].map(([name, s]) =>
  `| ${name} | ${pct(s.ms, 50)} ms | ${pct(s.ms, 90)} ms | ${s.total} | ${share(s.dated, s.total)} | ${share(s.inWindow, s.dated)} | ${s.relevant.length ? `${Math.round((s.relevant.reduce((a, b) => a + b, 0) / s.relevant.length) * 100)}%` : '–'} | ${s.errors} |`);
const md = [
  `# Search provider freshness test`,
  ``,
  `${queries.length} news-style queries, each limited to the last 7–30 days. Run ${new Date().toISOString().slice(0, 10)}.`,
  ``,
  `| Provider | p50 | p90 | Results | Dated | In window | Relevant | Errors |`,
  `|---|---|---|---|---|---|---|---|`,
  ...rows,
].join('\n');
mkdirSync(join(config.dataDir, 'eval'), { recursive: true });
writeFileSync(join(config.dataDir, 'eval', 'search.md'), md);
console.log(`\n${md}\n`);
