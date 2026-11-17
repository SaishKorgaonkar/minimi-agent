/**
 * The two prompts we optimise, each as a task: examples split into train /
 * val / test, and a scorer that returns a score in [0, 1] plus written
 * feedback (what GEPA calls actionable side information). Both optimisers,
 * the TypeScript one and the Python GEPA bridge, call `runExamples`, so they
 * see exactly the same data, models and scoring.
 */
import { readFileSync } from 'node:fs';
import { route } from '../../src/agent/router.js';
import { judgeClaims, type JudgeItem } from '../../src/claims/verify.js';
import type { Turn } from '../../src/db/repo.js';
import { prompt } from '../../src/prompts.js';
import type { Evidence } from '../../src/search/types.js';
import { resolveDateRange } from '../../src/time/resolve.js';

export type TaskName = 'router' | 'judge';
export type Split = 'train' | 'val' | 'test';

export interface Example { id: string; split: Split; input: unknown }
export interface Result { id: string; score: number; output: string; feedback: string; ms: number }

const TZ = 'Asia/Kolkata';
const NOW = new Date('2026-11-17T15:00:00+05:30'); // Tue 17 Nov 2026

// ── Router ──────────────────────────────────────────────────────────────

type Intent = 'chat' | 'search' | 'recall' | 'recall_verify';
interface RouterCase { message: string; intent: Intent; mention?: string[]; recent?: [string, string] }

const CRM_CONTEXT: [string, string] = [
  'We are a 20-person sales team. Shortlist 5 CRM tools for us with their pricing.',
  'Here is a shortlist: Zoho CRM Professional ($23/seat annual), Freshsales Growth ($9), HubSpot Sales Hub Starter ($20), Salesforce Starter Suite ($25), Pipedrive Lite ($14).',
];
const PG_CONTEXT: [string, string] = [
  'Compare managed Postgres hosting for a small production app: Neon, Supabase, RDS, Render.',
  'Neon Launch is usage-based, Supabase Pro starts at $25/month, RDS db.t4g.micro is about $14/month, Render starts at $6/month.',
];
const AI_CONTEXT: [string, string] = [
  'What are the most important AI model releases announced in the last 7 days?',
  '1. A new open-weights coding model [1]. 2. A multimodal model update with longer context [2]. 3. A speech model release [3].',
];

const ROUTER_CASES: RouterCase[] = [
  // chat: answerable without the web or memory
  { message: 'Thanks, that was helpful!', intent: 'chat' },
  { message: 'ok cool', intent: 'chat' },
  { message: 'Write a two-line poem about Postgres.', intent: 'chat' },
  { message: 'Can you explain what a vector index is, simply?', intent: 'chat' },
  { message: "Hey! How's it going?", intent: 'chat' },
  { message: "Translate 'good morning' into Spanish.", intent: 'chat' },
  { message: "What's 20 seats times $30 a month?", intent: 'chat' },
  { message: "thanks, that's all for now", intent: 'chat', recent: PG_CONTEXT },
  { message: 'Which of those would you pick for a hobby project?', intent: 'chat', recent: PG_CONTEXT },
  { message: 'Sounds good, we will go with HubSpot then.', intent: 'chat', recent: CRM_CONTEXT },
  // search: current or specific facts from the web
  { message: 'What is the current price of Supabase Pro?', intent: 'search', mention: ['supabase'] },
  { message: 'Compare Linear and Jira pricing for a 15-person team', intent: 'search', mention: ['linear', 'jira'] },
  { message: 'What happened in tech news on 3 November?', intent: 'search' },
  { message: 'Who won the F1 race last Sunday?', intent: 'search', mention: ['f1'] },
  { message: 'Latest Node.js LTS version?', intent: 'search', mention: ['node'] },
  { message: 'Is Vercel down right now?', intent: 'search', mention: ['vercel'] },
  { message: 'Neon vs PlanetScale vs Supabase: which is cheapest for a hobby app?', intent: 'search', mention: ['neon', 'planetscale', 'supabase'] },
  { message: 'Any news about OpenAI this week?', intent: 'search', mention: ['openai'] },
  { message: "What's the weather in Mumbai today?", intent: 'search', mention: ['mumbai'] },
  { message: 'How much does Notion AI cost per seat now?', intent: 'search', mention: ['notion'] },
  { message: 'Has Stripe changed its fees recently?', intent: 'search', mention: ['stripe'] },
  { message: 'What did Apple announce yesterday?', intent: 'search', mention: ['apple'] },
  { message: 'Tell me more about the second one.', intent: 'search', recent: AI_CONTEXT },
  { message: "What about Zoho's free plan limits?", intent: 'search', mention: ['zoho'], recent: CRM_CONTEXT },
  { message: 'Is there a Postgres host cheaper than Render for 1 GB?', intent: 'search', mention: ['postgres'], recent: PG_CONTEXT },
  // recall: about our earlier conversations
  { message: 'What did I ask you last Tuesday?', intent: 'recall' },
  { message: 'Which CRM tools did we shortlist on Monday? Just the names.', intent: 'recall' },
  { message: 'How big is my sales team?', intent: 'recall' },
  { message: 'Given the CRM budget I mentioned earlier, which of the CRMs we shortlisted fit within it?', intent: 'recall' },
  { message: 'Remind me what we decided about Postgres hosting.', intent: 'recall' },
  { message: 'What was the first thing I asked you today?', intent: 'recall' },
  { message: 'Did I ever ask you about Render?', intent: 'recall' },
  { message: "What's my CRM budget again?", intent: 'recall' },
  { message: 'Summarise our conversation from 3 November.', intent: 'recall' },
  { message: 'Which provider did you recommend for Postgres?', intent: 'recall' },
  { message: 'What did I tell you about my team size?', intent: 'recall' },
  // recall_verify: an earlier conversation AND whether it still holds
  { message: 'On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?', intent: 'recall_verify' },
  { message: 'What did I ask you on 3 November? Is your answer still correct today?', intent: 'recall_verify' },
  { message: 'Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?', intent: 'recall_verify' },
  { message: 'Is what you told me about the Node LTS still true?', intent: 'recall_verify' },
  { message: 'Are the CRM prices you gave me still accurate?', intent: 'recall_verify' },
  { message: 'Anything new with the Postgres providers we compared?', intent: 'recall_verify' },
  { message: 'Has HubSpot changed since we talked about it?', intent: 'recall_verify' },
  { message: 'Double-check the Supabase price you gave me last week.', intent: 'recall_verify' },
  { message: 'You said Freshsales was $9 a seat. Is that still right?', intent: 'recall_verify' },
  { message: 'Did any of the databases we looked at raise prices this month?', intent: 'recall_verify' },
  { message: 'What did we talk about yesterday, and is any of it outdated now?', intent: 'recall_verify' },
  { message: 'Has any of them changed pricing since?', intent: 'recall_verify', recent: CRM_CONTEXT },
];

/** Stratified split: within each intent, every third case goes to train, val, test. */
function splitOf(i: number): Split {
  return (['train', 'val', 'test'] as const)[i % 3];
}

function routerExamples(): Example[] {
  const byIntent = new Map<Intent, RouterCase[]>();
  for (const c of ROUTER_CASES) byIntent.set(c.intent, [...(byIntent.get(c.intent) ?? []), c]);
  return [...byIntent.values()].flatMap((list) =>
    list.map((c, i) => ({ id: `router:${c.intent}:${i}`, split: splitOf(i), input: c })));
}

function recentTurns(pair?: [string, string]): Turn[] {
  if (!pair) return [];
  const base = { conversation_id: 'c', reply_to: null, sources: null, meta: null, created_at: NOW.getTime() - 60_000, tz: TZ };
  return [
    { ...base, id: 'u', role: 'user', content: pair[0] },
    { ...base, id: 'a', role: 'assistant', content: pair[1] },
  ] as Turn[];
}

async function runRouter(instructions: string, c: RouterCase): Promise<Omit<Result, 'id' | 'ms'>> {
  const r = await route({ message: c.message, recent: recentTurns(c.recent), range: resolveDateRange(c.message, NOW, TZ), now: NOW, tz: TZ }, instructions);
  const notes: string[] = [];
  let score = 0;
  if (r.source === 'fallback') notes.push('The model did not answer in time (or failed), so a regex fallback decided; the score reflects that.');
  if (r.intent === c.intent) score += 0.8;
  else notes.push(`Intent was "${r.intent}" but should be "${c.intent}". ${why(c)}`);
  const q = r.searchQueries.join(' ').toLowerCase();
  if (c.mention?.length) {
    const missing = c.mention.filter((m) => !q.includes(m));
    score += 0.2 * (1 - missing.length / c.mention.length);
    if (missing.length) notes.push(`Search queries should name: ${missing.join(', ')} (one query per named product).`);
  } else if (c.intent === 'chat' || c.intent === 'recall') {
    if (r.searchQueries.length) notes.push('No search queries are needed for this intent.');
    score += r.searchQueries.length ? 0.1 : 0.2;
  } else score += 0.2;
  return {
    score,
    output: JSON.stringify({ intent: r.intent, searchQueries: r.searchQueries, onlySinceDate: r.onlySinceDate }),
    feedback: notes.join(' ') || 'Correct.',
  };
}

function why(c: RouterCase): string {
  switch (c.intent) {
    case 'chat': return 'It needs neither the web nor memory (small talk, writing, arithmetic, general knowledge, or an opinion about what is already in the conversation).';
    case 'search': return 'It asks for current or specific facts about the world; it does not refer back to an earlier conversation with the user.';
    case 'recall': return 'It asks what was said, asked, decided or mentioned earlier in our conversations, without asking whether it is still true.';
    case 'recall_verify': return 'It refers to something said earlier (by the user or by the assistant) AND asks whether it still holds, changed, or is outdated.';
  }
}

// ── Judge ───────────────────────────────────────────────────────────────

type Status = 'changed' | 'unchanged' | 'unverified';
interface JudgeFixture {
  id: string; vendor: string; entity: string;
  claims: JudgeItem['claims'];
  truth: { status: Status; value: string }[];
  evidence: Evidence[];
}

function judgeExamples(): Example[] {
  const fixtures = JSON.parse(readFileSync(new URL('./fixtures/judge.json', import.meta.url), 'utf8')) as JudgeFixture[];
  const vendors = [...new Set(fixtures.map((f) => f.vendor))].sort();
  // Split by vendor so no vendor's pages appear in both training and test.
  return fixtures.map((f) => ({ id: `judge:${f.id}`, split: splitOf(vendors.indexOf(f.vendor)), input: f }));
}

async function runJudge(instructions: string, f: JudgeFixture): Promise<Omit<Result, 'id' | 'ms'>> {
  const since = new Date(Math.min(...f.claims.map((c) => c.checked_at)));
  const out = await judgeClaims([{ entity: f.entity, claims: f.claims, evidence: f.evidence }], since, NOW, TZ, instructions);
  const verdicts = out?.entities.find((e) => e.entity === 0)?.claims ?? [];
  const notes: string[] = [];
  let points = 0;
  f.claims.forEach((c, i) => {
    const got = verdicts.find((v) => v.index === i)?.status ?? 'missing';
    const want = f.truth[i].status;
    const label = `Claim ${i} ("${c.entity}, ${c.attribute}: ${c.value}")`;
    if (got === want) { points += 1; return; }
    // A false "changed" would tell the user a price moved when it didn't: the worst error.
    if (got === 'changed') points -= 1;
    const hint = want === 'unchanged'
      ? 'the evidence shows this same value'
      : want === 'changed'
        ? `the evidence shows a different current value: "${f.truth[i].value}"`
        : 'the evidence does not mention this value at all, so it cannot be settled';
    notes.push(`${label}: answered "${got}", should be "${want}" because ${hint}.`);
  });
  return {
    score: Math.max(0, points / f.claims.length),
    output: JSON.stringify(verdicts.map((v) => ({ index: v.index, status: v.status, currentValue: v.currentValue }))),
    feedback: notes.join(' ') || 'All verdicts correct.',
  };
}

// ── Shared ──────────────────────────────────────────────────────────────

export const tasks = {
  router: { seed: () => prompt('router'), examples: routerExamples, run: (ins: string, x: unknown) => runRouter(ins, x as RouterCase) },
  judge: { seed: () => prompt('judge'), examples: judgeExamples, run: (ins: string, x: unknown) => runJudge(ins, x as JudgeFixture) },
};

/** A short, readable version of an example's input, for the reflection prompt. */
export function describeInput(task: TaskName, x: unknown): string {
  if (task === 'router') {
    const c = x as RouterCase;
    return (c.recent ? `Recent conversation: USER: ${c.recent[0]} / ASSISTANT: ${c.recent[1].slice(0, 160)}\n` : '') + `Message: ${c.message}`;
  }
  const f = x as JudgeFixture;
  return `Entity: ${f.entity}\nEarlier claims:\n${f.claims.map((c, i) => `${i}. ${c.entity}, ${c.attribute}: "${c.value}"`).join('\n')}\nEvidence:\n${f.evidence.map((e) => `[${e.n}] ${e.passages.join(' … ').slice(0, 700)}`).join('\n')}`;
}

/**
 * Router examples run one at a time, as in production (one route per turn):
 * concurrent calls on one key queue at the API and would push the router past
 * its timeout, measuring the queue instead of the prompt. The judge has no
 * timeout, so its examples can overlap.
 */
const CONCURRENCY: Record<TaskName, number> = { router: 1, judge: 4 };

export async function runExamples(task: TaskName, instructions: string, examples: Example[], concurrency = CONCURRENCY[task]): Promise<Result[]> {
  const out: Result[] = new Array(examples.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, examples.length) }, async () => {
    while (next < examples.length) {
      const i = next++;
      const ex = examples[i];
      const t0 = performance.now();
      try {
        const r = await tasks[task].run(instructions, ex.input);
        out[i] = { id: ex.id, ...r, ms: Math.round(performance.now() - t0) };
      } catch (err) {
        out[i] = { id: ex.id, score: 0, output: '', feedback: `Call failed: ${String((err as Error).message ?? err).slice(0, 200)}`, ms: Math.round(performance.now() - t0) };
      }
    }
  }));
  return out;
}
