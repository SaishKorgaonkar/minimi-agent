/**
 * Score the seed prompt and each optimiser's winner on the held-out test
 * split (never seen during optimisation), several runs each because the
 * model is not deterministic. Writes data/optimize/<task>-compare.md.
 *
 *   tsx scripts/optimize/compare.ts judge 3
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { runExamples, tasks, type TaskName } from './tasks.js';

const task = (process.argv[2] ?? 'judge') as TaskName;
const runs = Number(process.argv[3] ?? 3);
const test = tasks[task].examples().filter((e) => e.split === 'test');

const contenders: { name: string; text: string; val?: number }[] = [{ name: 'seed', text: tasks[task].seed() }];
// The optimisers' picks, plus each one's best rewritten (non-seed) prompt when their pick was the seed.
for (const [name, file] of [
  ['ts-gepa', `data/optimize/${task}-ts.json`], ['gepa', `data/optimize/${task}-gepa.json`],
  ['ts-gepa rewrite', `data/optimize/${task}-ts2.json`], ['gepa rewrite', `data/optimize/${task}-gepa2.json`],
] as const) {
  if (existsSync(file)) {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    if (!contenders.some((c) => c.text === r.best)) contenders.push({ name, text: r.best, val: r.bestVal });
  }
}

const rows: string[] = [];
const results: Record<string, number[]> = {};
for (const c of contenders) {
  const means: number[] = [];
  const errors = new Map<string, number>();
  let ms = 0;
  for (let i = 0; i < runs; i++) {
    const rs = await runExamples(task, c.text, test);
    means.push(rs.reduce((s, r) => s + r.score, 0) / rs.length);
    ms += rs.reduce((s, r) => s + r.ms, 0) / rs.length;
    for (const r of rs) for (const m of r.feedback.matchAll(/answered "(\w+)", should be "(\w+)"/g)) {
      const k = `${m[1]}→${m[2]}`;
      errors.set(k, (errors.get(k) ?? 0) + 1);
    }
  }
  results[c.name] = means;
  const avg = means.reduce((s, x) => s + x, 0) / runs;
  const errs = [...errors.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ×${(n / runs).toFixed(1)}`).join(', ') || 'none';
  const line = `| ${c.name} | ${c.val?.toFixed(3) ?? '–'} | **${avg.toFixed(3)}** | ${Math.min(...means).toFixed(3)}–${Math.max(...means).toFixed(3)} | ${c.text.length} | ${(ms / runs / 1000).toFixed(1)} s | ${errs} |`;
  rows.push(line);
  console.log(line);
}

const md = [
  `# ${task} prompt: seed vs optimised`, '',
  `Held-out test split: ${test.length} examples, ${runs} runs each. Errors are per run, as answered→expected.`, '',
  '| Prompt | Val (during search) | Test mean | Test range | Length (chars) | Latency/example | Errors per run |',
  '|---|---|---|---|---|---|---|',
  ...rows, '',
  ...contenders.map((c) => `## ${c.name}\n\n\`\`\`\n${c.text}\n\`\`\`\n`),
].join('\n');
writeFileSync(`data/optimize/${task}-compare.md`, md);
console.log(`Written to data/optimize/${task}-compare.md`);
