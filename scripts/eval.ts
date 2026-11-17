/**
 * npm run eval — end-to-end evaluation against the real models and search.
 *
 * Builds a fresh, isolated history (backdated, see history.ts), then asks
 * questions covering LongMemEval's five memory abilities plus this agent's
 * extra one: re-verifying an old answer against today's web.
 *
 * Each case is scored two ways:
 *  - deterministic checks (route chosen, recall found the right day, citations present)
 *  - an LLM judge with a rubric (reported separately, so the two can be compared)
 *
 * Results: printed as a table and written to data/eval/results.md.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.env.DATA_DIR ?? './data', 'eval');
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
process.env.DATA_DIR = dir;
process.env.RECHECK_AFTER_HOURS = '0';

const { assertConfig, config } = await import('../src/config.js');
const { now } = await import('../src/clock.js');
const { withNow } = await import('../src/clock.js');
const { runTurn } = await import('../src/agent/turn.js');
await import('../src/jobs/handlers.js');
const { drain, startWorker, stopWorker } = await import('../src/jobs/queue.js');
const { models, withOptionsFallback } = await import('../src/llm.js');
const { generateText, Output } = await import('ai');
const { z } = await import('zod');
const { seedHistory } = await import('./history.js');
const { formatDay } = await import('../src/time/tz.js');
const { getTurn } = await import('../src/db/repo.js');

const problems = assertConfig();
if (problems.length) {
  console.error(`Cannot run evals:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

const tz = process.env.USER_TZ ?? config.timezone;
const start = now();
const history = seedHistory(start, tz);
const monday = history.find((t) => /CRM tools/.test(t.message))!;
const tuesday = history.find((t) => /Postgres/.test(t.message))!;
const nov3 = history[0];
const hasUpdate = history.some((t) => /35 people/.test(t.message));

interface Case {
  ability: string;
  question: string;
  rubric: string;
  expectIntent?: string[];
  expectRecallDay?: Date;
  expectNoRecall?: boolean;
  expectCitations?: boolean;
}

const cases: Case[] = [
  {
    ability: 'Temporal reasoning',
    question: 'What did I ask you last Tuesday?',
    rubric: 'Says the user asked about managed Postgres hosting (Neon, Supabase, AWS RDS, Render) and refers to the right day.',
    expectIntent: ['recall', 'recall_verify'], expectRecallDay: tuesday.at,
  },
  {
    ability: 'Information extraction',
    question: 'Which CRM tools did we shortlist on Monday? Just the names.',
    rubric: 'Lists the CRM names that the Monday answer (in the reference) shortlisted, without inventing different ones.',
    expectIntent: ['recall', 'recall_verify'], expectRecallDay: monday.at,
  },
  {
    ability: 'Multi-session reasoning',
    question: 'Given the CRM budget I mentioned earlier, which of the CRMs we shortlisted fit within it?',
    rubric: 'Uses the $30 per seat per month budget from an earlier conversation and the Monday shortlist together to say which fit.',
  },
  {
    ability: 'Knowledge update',
    question: 'How big is my sales team?',
    rubric: hasUpdate
      ? 'Says the team is growing to 35 people (the newer statement), possibly noting it was 20 before. Answering only "20" fails.'
      : 'Says the team has 20 people.',
  },
  {
    ability: 'Abstention',
    question: `What did I ask you on ${formatDay(new Date(nov3.at.getTime() - 20 * 86_400_000), tz, true)}?`,
    rubric: 'Says clearly that there is no conversation on that date, does not invent one; mentioning the nearest real conversation is a plus.',
    expectNoRecall: true,
  },
  {
    ability: 'Re-verification (memory + web)',
    question: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?',
    rubric: 'Recalls the Tuesday comparison, then gives a per-provider verdict (changed / unchanged / could not verify) backed by citations, and is honest about anything it could not verify.',
    expectIntent: ['recall_verify'], expectRecallDay: tuesday.at, expectCitations: true,
  },
  {
    ability: 'Re-verification (memory + web)',
    question: `What did I ask you on ${formatDay(nov3.at, tz, true)}? Is your answer still correct today?`,
    rubric: 'Recalls the Node.js LTS question from that day and checks whether the earlier answer still holds, with citations.',
    expectIntent: ['recall_verify'], expectRecallDay: nov3.at, expectCitations: true,
  },
  {
    ability: 'Fresh web search',
    question: 'What are the most important AI model releases announced in the last 7 days?',
    rubric: 'Gives recent, dated releases with citations; does not present old news as new.',
    expectIntent: ['search'], expectCitations: true,
  },
  {
    ability: 'Small talk (no search)',
    question: 'Thanks, that was helpful!',
    rubric: 'Responds briefly and naturally; does not search or dump information.',
    expectIntent: ['chat'],
  },
];

startWorker();
console.log(`Building eval history: ${history.length} backdated questions…`);
const threads = new Map<string, string>();
const reference: string[] = [];
for (const t of history) {
  let conversationId = threads.get(t.thread);
  const r = await withNow(t.at, () => runTurn({ message: t.message, tz, conversationId }, (e) => {
    if (e.type === 'meta') conversationId = e.conversationId;
  }));
  if (conversationId) threads.set(t.thread, conversationId);
  reference.push(`[${formatDay(t.at, tz, true)}] USER: ${t.message}\nASSISTANT: ${r.text.slice(0, 4000)}`);
  await drain();
}

function sourceList(turnId: string | null): string {
  const raw = turnId ? getTurn(turnId)?.sources : null;
  const sources = raw ? (JSON.parse(raw) as { n: number; title: string; url: string; publishedAt: string | null }[]) : [];
  return sources.map((s) => `[${s.n}] ${s.title} (${s.publishedAt?.slice(0, 10) ?? 'undated'}) ${s.url}`).join('\n') || '(none)';
}

const judgeSchema = z.object({ pass: z.boolean(), score: z.number().describe('0 to 1'), reason: z.string() });

interface Row { ability: string; question: string; intent: string; checks: string[]; checksPass: boolean; judge: { pass: boolean; score: number; reason: string }; firstTokenMs: number | null; totalMs: number }
const rows: Row[] = [];
const evalConversation = { id: undefined as string | undefined };

console.log(`Running ${cases.length} cases…\n`);
for (const c of cases) {
  // Pace like a person: background jobs from the previous answer finish while
  // they read it. BACK_TO_BACK=1 skips this to measure the worst case.
  if (!process.env.BACK_TO_BACK) await drain();
  const t0 = performance.now();
  let firstToken: number | null = null;
  let intent = '?';
  let recall: { found: number; range?: { start: number; end: number } } | null = null;
  let citations = 0;
  const result = await runTurn({ message: c.question, tz, conversationId: evalConversation.id }, (e) => {
    if (e.type === 'meta') evalConversation.id = e.conversationId;
    if (e.type === 'delta' && firstToken === null) firstToken = performance.now() - t0;
    if (e.type === 'done') intent = e.intent;
    if (e.type === 'recall') recall = e;
  });
  const totalMs = performance.now() - t0;
  citations = (result.text.match(/\[\d+\]/g) ?? []).length;

  const checks: string[] = [];
  let ok = true;
  if (c.expectIntent) {
    const pass = c.expectIntent.includes(intent);
    ok &&= pass;
    checks.push(`${pass ? '✓' : '✗'} route=${intent}`);
  }
  if (c.expectRecallDay) {
    const r = recall as { found: number; range?: { start: number; end: number } } | null;
    const t = c.expectRecallDay.getTime();
    const pass = !!r && r.found > 0 && !!r.range && r.range.start <= t && t < r.range.end;
    ok &&= pass;
    checks.push(`${pass ? '✓' : '✗'} recalled right day`);
  }
  if (c.expectNoRecall) {
    const r = recall as { found: number } | null;
    const pass = !!r && r.found === 0;
    ok &&= pass;
    checks.push(`${pass ? '✓' : '✗'} found nothing`);
  }
  if (c.expectCitations) {
    const pass = citations > 0;
    ok &&= pass;
    checks.push(`${pass ? '✓' : '✗'} ${citations} citations`);
  }

  const { output } = await withOptionsFallback('extract', (providerOptions) => generateText({
    model: models.extract(),
    providerOptions,
    output: Output.object({ schema: judgeSchema }),
    instructions: 'You grade a chat assistant. Use the rubric and the reference conversation history. Be strict but fair. Do not reward length.',
    prompt: `REFERENCE HISTORY:\n${reference.join('\n\n')}\n\nQUESTION (asked ${formatDay(now(), tz, true)}):\n${c.question}\n\nANSWER:\n${result.text}\n\nSOURCES SHOWN WITH THE ANSWER (what the [n] citations link to):\n${sourceList(result.turnId)}\n\nRUBRIC:\n${c.rubric}`,
  }));
  const judge = output ?? { pass: false, score: 0, reason: 'judge failed' };
  rows.push({ ability: c.ability, question: c.question, intent, checks, checksPass: ok, judge, firstTokenMs: firstToken, totalMs });
  console.log(`${judge.pass && ok ? 'PASS' : 'FAIL'}  ${c.ability.padEnd(32)} first word ${firstToken ? (firstToken / 1000).toFixed(1) : '–'}s  total ${(totalMs / 1000).toFixed(1)}s  ${checks.join(' ')}\n      ${judge.reason}`);
}
await drain();
stopWorker();

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : 0;
};
const ft = rows.map((r) => r.firstTokenMs).filter((x): x is number => x !== null);
const passed = rows.filter((r) => r.checksPass && r.judge.pass).length;
const md = [
  `# Eval results`,
  ``,
  `Run ${start.toISOString()} · models: answer ${config.models.answer}, router ${config.models.router}, extract ${config.models.extract} · search: ${process.env.SEARCH_PROVIDERS ?? 'all configured'}`,
  ``,
  `**${passed}/${rows.length} passed** (deterministic checks and judge both pass). First word p50 ${(pct(ft, 50) / 1000).toFixed(1)}s, p90 ${(pct(ft, 90) / 1000).toFixed(1)}s.`,
  ``,
  `| Ability | Question | Route | Checks | Judge | First word | Total |`,
  `|---|---|---|---|---|---|---|`,
  ...rows.map((r) => `| ${r.ability} | ${r.question.replace(/\|/g, '/')} | ${r.intent} | ${r.checks.join(', ') || '–'} | ${r.judge.pass ? '✓' : '✗'} ${r.judge.score.toFixed(2)} — ${r.judge.reason.replace(/\|/g, '/').slice(0, 160)} | ${r.firstTokenMs ? (r.firstTokenMs / 1000).toFixed(1) + 's' : '–'} | ${(r.totalMs / 1000).toFixed(1)}s |`),
].join('\n');
writeFileSync(join(dir, 'results.md'), md);
console.log(`\n${passed}/${rows.length} passed. First word p50 ${(pct(ft, 50) / 1000).toFixed(1)}s. Written to ${join(dir, 'results.md')}`);
process.exit(0);
