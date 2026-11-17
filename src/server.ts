import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { assertConfig, config } from './config.js';
import { nowMs, withNow } from './clock.js';
import { getDb } from './db/index.js';
import {
  conversationTurns, countTurns, getTurn, listConversations, markNudgeSeen, tracesForTurn, unseenNudges,
} from './db/repo.js';
import { runTurn, type TurnEvent } from './agent/turn.js';
import './jobs/handlers.js';
import { jobStats, startWorker } from './jobs/queue.js';
import { log } from './log.js';
import { enabledProviders } from './search/providers.js';
import { json } from './util.js';

const app = new Hono();

app.get('/api/health', (c) => c.json({
  ok: assertConfig().length === 0,
  problems: assertConfig(),
  models: config.models,
  searchProviders: enabledProviders().map((p) => p.name),
  turns: countTurns(),
  jobs: jobStats(),
}));

app.post('/api/chat', async (c) => {
  const body = await c.req.json<{ message?: string; conversationId?: string; tz?: string }>().catch(() => null);
  const message = body?.message?.trim();
  if (!message) return c.json({ error: 'message is required' }, 400);
  const problems = assertConfig();
  if (problems.length) return c.json({ error: problems.join('; ') }, 503);

  // `x-now` simulates the current time (seed script, evals, demos).
  const override = config.allowClockOverride ? c.req.header('x-now') : undefined;
  const at = override && Number.isFinite(Date.parse(override)) ? new Date(override) : null;

  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());
    // Writes are chained so events stay in order and the last one is flushed before the stream closes.
    let writes = Promise.resolve();
    const send = (e: TurnEvent) => {
      writes = writes.then(() => stream.writeSSE({ event: e.type, data: JSON.stringify(e) })).catch(() => {});
    };
    const run = () => runTurn({ message, conversationId: body?.conversationId, tz: body?.tz, signal: controller.signal }, send);
    await (at ? withNow(at, run) : run());
    await writes;
  });
});

app.get('/api/conversations', (c) => c.json(listConversations()));

app.get('/api/conversations/:id', (c) => c.json(
  conversationTurns(c.req.param('id')).map((t) => ({
    id: t.id, role: t.role, content: t.content, createdAt: t.created_at, tz: t.tz,
    sources: json(t.sources, []), meta: json(t.meta, null),
  })),
));

app.get('/api/nudges', (c) => c.json(unseenNudges()));
app.post('/api/nudges/:id/seen', (c) => {
  markNudgeSeen(c.req.param('id'), nowMs());
  return c.json({ ok: true });
});

app.get('/api/traces/:turnId', (c) => {
  const turn = getTurn(c.req.param('turnId'));
  const userTurnId = turn?.role === 'assistant' ? turn.reply_to : turn?.id;
  return c.json({ turn, traces: userTurnId ? tracesForTurn(userTurnId) : [] });
});

app.get('/debug/turn/:turnId', serveStatic({ path: './public/debug.html' }));
app.use('/*', serveStatic({ root: './public' }));

getDb();
startWorker();
const problems = assertConfig();
serve({ fetch: app.fetch, port: config.port }, (info) => {
  log.info({ url: `http://localhost:${info.port}`, providers: enabledProviders().map((p) => p.name), models: config.models }, 'chat agent ready');
  for (const p of problems) log.warn(p);
});
