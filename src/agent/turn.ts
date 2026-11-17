import { isStepCount, streamText, tool, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import { config } from '../config.js';
import { now as clockNow } from '../clock.js';
import { getDb } from '../db/index.js';
import {
  claimsForTurns, ensureConversation, insertTurn, recentTurns, type Exchange, type Source,
} from '../db/repo.js';
import { verifyClaims, formatReport } from '../claims/verify.js';
import { enqueue } from '../jobs/queue.js';
import { disableOptions, isOptionsError, models, providerOptions } from '../llm.js';
import { log } from '../log.js';
import { recall, type RecallResult } from '../memory/recall.js';
import { formatEvidence, SourceRegistry, webSearch } from '../search/index.js';
import type { Evidence } from '../search/types.js';
import { resolveDateRange, type DateRange } from '../time/resolve.js';
import { formatDay, isoDay, isValidTimezone } from '../time/tz.js';
import { Tracer } from '../trace.js';
import { route, type Route } from './router.js';
import { formatMemory, systemPrompt } from './prompts.js';

/**
 * One chat turn, end to end:
 *
 *   save question → resolve dates (code) → route ‖ recall (parallel)
 *     → [verify old claims | first search] → stream answer (≤ N tool calls)
 *     → save answer + enqueue background jobs (one transaction)
 */

export type TurnEvent =
  | { type: 'meta'; conversationId: string; userTurnId: string }
  | { type: 'status'; text: string }
  | { type: 'recall'; label: string; found: number; range?: { start: number; end: number } }
  | { type: 'sources'; sources: Source[] }
  | { type: 'delta'; text: string }
  | { type: 'done'; turnId: string; conversationId: string; intent: Route['intent']; timings: Record<string, number> }
  | { type: 'error'; message: string };

export interface TurnInput {
  conversationId?: string;
  message: string;
  tz?: string;
  signal?: AbortSignal;
}

export async function runTurn(input: TurnInput, emit: (e: TurnEvent) => void): Promise<{ turnId: string | null; text: string }> {
  const now = clockNow();
  const tz = input.tz && isValidTimezone(input.tz) ? input.tz : config.timezone;
  const message = input.message.trim().slice(0, 8000);

  // 1. Save the question first: even if everything after fails, memory has it.
  const conversationId = ensureConversation(input.conversationId, now.getTime());
  const recent = recentTurns(conversationId, config.agent.recentTurns);
  const userTurnId = insertTurn({
    conversation_id: conversationId, role: 'user', content: message, reply_to: null,
    sources: null, meta: null, created_at: now.getTime(), tz,
  });
  const tracer = new Tracer(userTurnId);
  emit({ type: 'meta', conversationId, userTurnId });

  try {
    // 2. Dates: deterministic, ~1ms.
    const range = resolveDateRange(message, now, tz);
    tracer.event('resolve_dates', range && { label: range.label, start: range.start.toISOString(), end: range.end.toISOString(), text: range.text });

    // 3. Routing and memory lookup run in parallel.
    const inContext = new Set(recent.filter((t) => t.role === 'user').map((t) => t.id));
    const [plan, recalled] = await Promise.all([
      tracer.span('route', () => route({ message, recent, range, now, tz }), (r) => r),
      tracer.span('recall', () => recall({ query: message, range, excludeTurnId: userTurnId, alreadyInContext: inContext }),
        (r) => ({ mode: r.mode, found: r.exchanges.length, ids: r.exchanges.map((e) => e.userTurnId) })),
    ]);
    let memory = recalled;
    tracer.mark('planned');
    // A date in a question about the world ("what happened on 3 Nov?") isn't a memory lookup:
    // only report "nothing found that day" when the user was asking about our conversations.
    if (memory.mode === 'range' && !memory.exchanges.length && (plan.intent === 'search' || plan.intent === 'chat')) {
      memory = { mode: 'none', exchanges: [], facts: new Map() };
    }
    emitRecall(memory, tz, emit);

    // 4. Gather evidence before the answer model starts.
    const registry = new SourceRegistry();
    let verification: string | null = null;
    let evidence: Evidence[] = [];

    const wantsVerify = plan.intent === 'recall_verify' && memory.exchanges.length > 0;
    if (wantsVerify) {
      verification = await tracer.span('verify', () => verifyPast(memory.exchanges, range, plan, registry, emit, tz), (v) => ({ chars: v?.length ?? 0 }));
    } else if (plan.intent === 'search' || (plan.intent === 'recall_verify' && !memory.exchanges.length && plan.searchQueries.length)) {
      emit({ type: 'status', text: 'Searching the web' });
      const after = plan.onlySinceDate && range ? range.start : undefined;
      const run = await tracer.span('search', () => webSearch({
        queries: plan.searchQueries.length ? plan.searchQueries : [message], after, topic: plan.topic,
      }, registry), (r) => r.stats);
      evidence = run.evidence;
    }
    if (registry.all().length) emit({ type: 'sources', sources: toSources(registry.all()) });
    tracer.mark('evidence_ready');

    // 5. Stream the answer. The model can still search (single tool) if the evidence isn't enough.
    const instructions = systemPrompt({
      now, tz,
      memory: formatMemory(memory, tz),
      verification,
      evidence: evidence.length ? formatEvidence(evidence) : null,
    });
    const messages: ModelMessage[] = [
      ...recent.map((t) => ({ role: t.role, content: t.content }) as ModelMessage),
      { role: 'user', content: message },
    ];
    const tools = {
      web_search: tool({
        description: 'Search the web. Returns numbered sources with dates and relevant passages. Cite them as [n].',
        inputSchema: z.object({
          query: z.string().describe('A specific search query'),
          after: z.string().optional().describe('Only pages published on/after this date, YYYY-MM-DD'),
          topic: z.enum(['general', 'news']).optional(),
        }),
        execute: async ({ query, after, topic }) => {
          emit({ type: 'status', text: `Searching: ${query}` });
          const afterDate = after && !Number.isNaN(Date.parse(after)) ? new Date(after) : undefined;
          const run = await tracer.span('tool_search', () => webSearch({ queries: [query], after: afterDate, topic }, registry), (r) => r.stats);
          emit({ type: 'sources', sources: toSources(registry.all()) });
          return formatEvidence(run.evidence);
        },
      }),
    };

    if (!wantsVerify && plan.intent !== 'search') emit({ type: 'status', text: 'Writing' });
    const text = await tracer.span('answer', () => streamAnswer({ instructions, messages, tools, tracer, emit, signal: input.signal }), (t) => ({ chars: t.length }));

    // 6. Save the answer and its background jobs atomically.
    const all = toSources(registry.all());
    const cited = all.filter((s) => text.includes(`[${s.n}]`));
    const assistantTurnId = getDb().transaction(() => {
      const aid = insertTurn({
        conversation_id: conversationId, role: 'assistant', content: text, reply_to: userTurnId,
        sources: JSON.stringify(cited.length ? cited : all.slice(0, 5)),
        meta: JSON.stringify({ intent: plan.intent, routeSource: plan.source, range: range && { label: range.label, start: range.start.getTime(), end: range.end.getTime() } }),
        created_at: clockNow().getTime(), tz,
      });
      enqueue('index_turn', { userTurnId, assistantTurnId: aid });
      enqueue('extract_claims', { userTurnId, assistantTurnId: aid });
      return aid;
    })();

    tracer.mark('done');
    emit({ type: 'done', turnId: assistantTurnId, conversationId, intent: plan.intent, timings: tracer.marks });
    return { turnId: assistantTurnId, text };
  } catch (err) {
    log.error({ err: String((err as Error)?.stack ?? err), turn: userTurnId }, 'turn failed');
    tracer.event('error', { message: String((err as Error)?.message ?? err) });
    emit({ type: 'error', message: friendlyError(err) });
    return { turnId: null, text: '' };
  } finally {
    tracer.flush();
  }
}

async function streamAnswer(opts: {
  instructions: string;
  messages: ModelMessage[];
  tools: ToolSet;
  tracer: Tracer;
  emit: (e: TurnEvent) => void;
  signal?: AbortSignal;
}): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let text = '';
    let failure: unknown = null;
    const result = streamText({
      model: models.answer(),
      providerOptions: providerOptions('answer'),
      instructions: opts.instructions,
      messages: opts.messages,
      tools: opts.tools,
      stopWhen: isStepCount(config.agent.maxSteps),
      abortSignal: opts.signal,
    });
    for await (const part of result.fullStream) {
      if (part.type === 'text-delta') {
        if (!text) opts.tracer.mark('first_token');
        text += part.text;
        opts.emit({ type: 'delta', text: part.text });
      } else if (part.type === 'error') {
        failure = part.error;
      }
    }
    if (!failure) return text;
    // A model that rejects our reasoning options: drop them and retry once, if nothing was shown yet.
    if (!text && attempt === 0 && isOptionsError(failure)) {
      disableOptions('answer', failure);
      continue;
    }
    if (text) return text; // partial answer is better than none; the error is in the trace
    throw failure;
  }
  return '';
}

/** "Has anything changed since?" — re-check the claims from the recalled conversations. */
async function verifyPast(exchanges: Exchange[], range: DateRange | null, plan: Route, registry: SourceRegistry, emit: (e: TurnEvent) => void, tz: string): Promise<string> {
  const since = range?.start ?? new Date(Math.min(...exchanges.map((e) => e.createdAt)));
  const assistantIds = exchanges.map((e) => e.assistantTurnId).filter((x): x is string => !!x);
  const claims = claimsForTurns(assistantIds);
  if (claims.length) {
    const reports = await verifyClaims(claims, since, registry, (msg) => emit({ type: 'status', text: msg }), tz);
    return `Earlier claims (from ${formatDay(since, tz)}) checked against today's evidence:\n\n${formatReport(reports)}`;
  }
  // No structured claims (e.g. extraction still running): search for changes since then instead.
  emit({ type: 'status', text: 'Searching for changes since then' });
  const queries = plan.searchQueries.length ? plan.searchQueries : exchanges.slice(0, 3).map((e) => e.question.slice(0, 160));
  const run = await webSearch({ queries, after: since, topic: 'news' }, registry);
  return `No structured claims were stored for that conversation, so compare the earlier answer in MEMORY with this evidence (published after ${isoDay(since, tz)}):\n\n${formatEvidence(run.evidence)}`;
}

function emitRecall(memory: RecallResult, tz: string, emit: (e: TurnEvent) => void) {
  if (memory.mode === 'none') return;
  const range = memory.range && { start: memory.range.start.getTime(), end: memory.range.end.getTime() };
  if (memory.mode === 'range' && !memory.exchanges.length) {
    emit({ type: 'recall', label: `No conversation found for ${memory.range!.label}`, found: 0, range });
    return;
  }
  const days = [...new Set(memory.exchanges.map((e) => formatDay(new Date(e.createdAt), tz)))];
  const label = memory.mode === 'range'
    ? `Recalled ${memory.exchanges.length} ${memory.exchanges.length === 1 ? 'question' : 'questions'} from ${memory.range!.label}`
    : `Related: ${days.slice(0, 3).join(', ')}`;
  emit({ type: 'recall', label, found: memory.exchanges.length, range });
}

function toSources(evidence: Evidence[]): Source[] {
  return evidence.map((e) => ({ n: e.n, url: e.url, title: e.title, publishedAt: e.publishedAt, fetchedAt: e.fetchedAt }));
}

function friendlyError(err: unknown): string {
  const msg = String((err as Error)?.message ?? err);
  if (/api key|401|unauthorized/i.test(msg)) return 'The model provider rejected the API key. Check OPENAI_API_KEY in .env.';
  if (/429|rate limit/i.test(msg)) return 'Rate limited by the model provider. Try again in a moment.';
  if (/abort/i.test(msg)) return 'Stopped.';
  return 'Something went wrong while answering. The details are in the server log.';
}
