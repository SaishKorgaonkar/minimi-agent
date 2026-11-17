import { generateText, Output } from 'ai';
import { z } from 'zod';
import { config } from '../config.js';
import { models, withOptionsFallback } from '../llm.js';
import type { Turn } from '../db/repo.js';
import type { DateRange } from '../time/resolve.js';
import { formatDateTime } from '../time/tz.js';
import { truncate, within } from '../util.js';

/**
 * A fast model decides what this turn needs, and plans the first search.
 * Running the first search before the expensive model starts saves a whole
 * model round trip (the answer model doesn't have to ask for it).
 */

export const routeSchema = z.object({
  intent: z.enum(['chat', 'search', 'recall', 'recall_verify']).describe(
    'chat: small talk or something answerable without the web or memory. ' +
    'search: needs current or specific facts from the web. ' +
    'recall: asks about earlier conversations ("what did I ask…", "what did we decide…"). ' +
    'recall_verify: refers to an earlier conversation AND asks whether it is still true or what changed since.',
  ),
  searchQueries: z.array(z.string()).describe(
    '0-4 specific web search queries for this turn (empty for chat/recall). When comparing named products, one query per product. Resolve pronouns using the conversation. Include the current year for time-sensitive topics.',
  ),
  topic: z.enum(['general', 'news']).describe('news when the user wants recent announcements or changes'),
  onlySinceDate: z.boolean().describe('true when results should be limited to after the date the user referred to ("since then", "since Monday")'),
});

export type Route = z.infer<typeof routeSchema> & { source: 'model' | 'fallback' };

export async function route(input: { message: string; recent: Turn[]; range: DateRange | null; now: Date; tz: string }): Promise<Route> {
  const history = input.recent.slice(-4).map((t) => `${t.role.toUpperCase()}: ${truncate(t.content, 400)}`).join('\n');
  const call = withOptionsFallback('router', (providerOptions) =>
    generateText({
      model: models.router(),
      providerOptions,
      output: Output.object({ schema: routeSchema }),
      instructions: 'You route messages for a chat assistant that has web search and memory of past conversations. Reply with the routing decision only.',
      prompt:
        `Now: ${formatDateTime(input.now, input.tz)} (${input.tz})\n` +
        (input.range ? `The message refers to: ${input.range.label} ("${input.range.text}")\n` : '') +
        (history ? `\nRecent conversation:\n${history}\n` : '') +
        `\nMessage: ${input.message}`,
    }).then((r) => r.output),
  );
  const out = await within(call, config.agent.routerTimeoutMs, null);
  if (!out) return fallbackRoute(input.message, input.range);
  return { ...out, searchQueries: out.searchQueries.slice(0, 4), source: 'model' };
}

/** Used if the router is slow or fails: simple rules, biased toward searching. */
export function fallbackRoute(message: string, range: DateRange | null): Route {
  const m = message.toLowerCase();
  const asksAboutPast = /\b(did (i|we)|i asked|(i|we) (mentioned|discussed|talked|shortlisted|decided|compared|said)|you (said|told|answered|recommended)|remember|earlier|last time|my (team|budget|company))\b/.test(m);
  const asksIfChanged = /\b(still|changed|change|since|any update|today|now|current|correct|true)\b/.test(m);
  const smallTalk = /^(hi|hello|hey|thanks|thank you|ok|okay|cool|great|nice|perfect)\b/.test(m.trim()) && m.split(/\s+/).length <= 6 && !m.includes('?');
  if (smallTalk) return { intent: 'chat', searchQueries: [], topic: 'general', onlySinceDate: false, source: 'fallback' };
  if ((range || asksAboutPast) && asksIfChanged) {
    return { intent: 'recall_verify', searchQueries: [], topic: 'news', onlySinceDate: true, source: 'fallback' };
  }
  if (asksAboutPast) return { intent: 'recall', searchQueries: [], topic: 'general', onlySinceDate: false, source: 'fallback' };
  return { intent: 'search', searchQueries: [message.slice(0, 200)], topic: 'general', onlySinceDate: false, source: 'fallback' };
}
