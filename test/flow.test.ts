/**
 * End-to-end flow test with mock models and a fake search provider: no network,
 * no API keys. Exercises the full path the challenge examples need:
 *   ask on Monday → background extraction → "has anything changed since Monday?"
 */
process.env.NODE_ENV = 'test';
process.env.RECHECK_AFTER_HOURS = '0';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { simulateReadableStream } from 'ai';
import { MockEmbeddingModelV4, MockLanguageModelV4 } from 'ai/test';

const { openDb, setDb, getDb } = await import('../src/db/index.js');
setDb(openDb(':memory:'));
const { setTestModels } = await import('../src/llm.js');
const { setTestProviders } = await import('../src/search/providers.js');
const { withNow } = await import('../src/clock.js');
const { runTurn } = await import('../src/agent/turn.js');
await import('../src/jobs/handlers.js');
const { startWorker, stopWorker, drain } = await import('../src/jobs/queue.js');

const TZ = 'Asia/Kolkata';
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 10, text: 10, reasoning: undefined },
};

function promptText(options: any): string {
  return (options.prompt as any[]).map((m) =>
    typeof m.content === 'string' ? m.content : m.content.map((p: any) => p.text ?? '').join(' ')).join('\n');
}

const generated = (obj: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(obj) }],
  finishReason: { unified: 'stop' as const, raw: undefined },
  usage,
  warnings: [],
});

// Router: decides from the message text, like the real one would.
const router = new MockLanguageModelV4({
  doGenerate: async (options) => {
    const msg = promptText(options).split('Message:').pop()!.toLowerCase();
    if (/changed|since|still correct/.test(msg)) return generated({ intent: 'recall_verify', searchQueries: [], topic: 'news', onlySinceDate: true });
    if (/what did i ask|did we look at/.test(msg)) return generated({ intent: 'recall', searchQueries: [], topic: 'general', onlySinceDate: false });
    return generated({ intent: 'search', searchQueries: ['best CRM for 20 person sales team 2026'], topic: 'general', onlySinceDate: false });
  },
});

// Extraction and verification judge share the "extract" model.
const extract = new MockLanguageModelV4({
  doGenerate: async (options) => {
    const p = promptText(options);
    if (p.includes('EARLIER CLAIMS')) {
      const changed = p.includes('Entity: Pipedrive');
      return generated({
        claims: [{ index: 0, status: changed ? 'changed' : 'unchanged', currentValue: changed ? '$19/user/month' : null, evidence: [1], note: changed ? 'Price raised' : null }],
        news: changed ? [{ summary: 'Pipedrive launched an AI sales assistant', evidence: [1] }] : [],
      });
    }
    return generated({
      facts: ['User has a 20-person sales team', 'Shortlisted CRMs: HubSpot, Pipedrive'],
      claims: [
        { entity: 'Pipedrive', attribute: 'Essential plan price', value: '$14/user/month', source: 1 },
        { entity: 'HubSpot', attribute: 'Starter price', value: '$20/seat/month', source: 2 },
      ],
    });
  },
});

// Answer model: records what it was given so the test can inspect the prompt.
const answerPrompts: string[] = [];
const answer = new MockLanguageModelV4({
  doStream: async (options) => {
    answerPrompts.push(promptText(options));
    const text = 'Here is the answer [1].';
    return {
      stream: simulateReadableStream({
        chunks: [
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: text },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
        ],
      }),
    };
  },
});

// Deterministic bag-of-words embeddings, so semantic recall is meaningful.
function vec(text: string): number[] {
  const v = new Array(1536).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % 1536;
    v[h] += 1;
  }
  return v;
}
const embed = new MockEmbeddingModelV4({
  doEmbed: async ({ values }) => ({ embeddings: values.map((t: string) => vec(t)), warnings: [] }),
});

const searchCalls: { query: string; after?: Date }[] = [];
setTestModels({ router, extract, answer, embed });
setTestProviders([{
  name: 'fake',
  async search(q) {
    searchCalls.push({ query: q.query, after: q.after });
    return [
      { url: 'https://pipedrive.invalid/pricing', title: 'Pipedrive pricing', snippet: 'Essential $14/user/month', text: 'Pipedrive Essential plan costs $14/user/month billed annually.', publishedAt: '2026-11-01', provider: 'fake', rank: 0 },
      { url: 'https://hubspot.invalid/pricing', title: 'HubSpot pricing', snippet: 'Starter $20/seat/month', text: 'HubSpot Starter is $20/seat/month.', publishedAt: '2026-10-20', provider: 'fake', rank: 1 },
    ];
  },
}]);

async function ask(message: string, at: string, conversationId?: string) {
  const events: any[] = [];
  const r = await withNow(new Date(at), () => runTurn({ message, tz: TZ, conversationId }, (e) => events.push(e)));
  return { ...r, events };
}

before(() => startWorker());
after(() => stopWorker());

test('Monday question → stored, indexed, claims extracted', async () => {
  const r = await ask('Shortlist 5 CRM tools for a 20-person sales team', '2026-11-09T10:00:00+05:30');
  assert.ok(r.turnId, 'answer saved');
  assert.equal(r.events.find((e) => e.type === 'done')?.intent, 'search');
  assert.ok(r.events.some((e) => e.type === 'sources' && e.sources.length === 2));
  await drain(10_000);
  const claims = getDb().prepare('SELECT * FROM claims').all() as any[];
  assert.equal(claims.length, 2);
  assert.equal(claims[0].source_url !== null, true, 'claims are tied to sources');
  const facts = getDb().prepare("SELECT * FROM memory_items WHERE kind = 'fact'").all();
  assert.equal(facts.length, 2);
});

test('"Has anything changed since Monday?" → recalls Monday, verifies claims, versions the changed one', async () => {
  const r = await ask('On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing since?', '2026-11-12T15:00:00+05:30');
  const recall = r.events.find((e) => e.type === 'recall');
  assert.match(recall.label, /Recalled 1 question from Mon 9 Nov/);
  const prompt = answerPrompts.at(-1)!;
  assert.match(prompt, /# MEMORY/);
  assert.match(prompt, /# VERIFICATION/);
  assert.match(prompt, /CHANGED Essential plan price: was "\$14\/user\/month" → now "\$19\/user\/month"/);
  assert.match(prompt, /UNCHANGED Starter price/);
  // Verification searches are limited to after Monday.
  const verifySearch = searchCalls.filter((c) => c.after).at(-1)!;
  assert.equal(verifySearch.after!.toISOString(), '2026-11-08T18:30:00.000Z'); // Mon 9 Nov 00:00 IST
  // Old claim kept, superseded by a new version.
  const pipedrive = getDb().prepare("SELECT * FROM claims WHERE entity = 'Pipedrive' ORDER BY checked_at").all() as any[];
  assert.equal(pipedrive.length, 2);
  assert.equal(pipedrive[0].superseded_by, pipedrive[1].id);
  assert.equal(pipedrive[1].value, '$19/user/month');
  const verifications = getDb().prepare('SELECT status FROM verifications ORDER BY status').all() as any[];
  assert.deepEqual(verifications.map((v) => v.status), ['changed', 'unchanged']);
});

test('"What did I ask on 3 November?" with no history that day → honest "nothing found" + nearest', async () => {
  const r = await ask('What did I ask you on 3 November?', '2026-11-12T15:05:00+05:30');
  assert.match(r.events.find((e) => e.type === 'recall').label, /No conversation found for Tue 3 Nov/);
  const prompt = answerPrompts.at(-1)!;
  assert.match(prompt, /No conversation found for Tue 3 Nov/);
  assert.match(prompt, /Nearest conversations:[\s\S]*Shortlist 5 CRM tools/);
});

test('No date, topic question → semantic recall across sessions', async () => {
  const r = await ask('Which CRM tools did we look at for my sales team?', '2026-11-12T15:10:00+05:30');
  const recall = r.events.find((e) => e.type === 'recall');
  assert.ok(recall, 'recalled something');
  assert.match(answerPrompts.at(-1)!, /Shortlist 5 CRM tools/);
});

test('Background jobs all finish', async () => {
  await drain(10_000);
  const failed = getDb().prepare("SELECT * FROM jobs WHERE status = 'failed'").all();
  assert.deepEqual(failed, []);
});
