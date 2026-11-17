import type { Exchange } from '../db/repo.js';
import type { RecallResult } from '../memory/recall.js';
import { formatDateTime } from '../time/tz.js';
import { truncate } from '../util.js';

export function systemPrompt(input: {
  now: Date;
  tz: string;
  memory: string | null;
  verification: string | null;
  evidence: string | null;
}): string {
  const parts = [
    `You are a fast, accurate chat assistant with live web search and a long-term memory of past conversations with this user.`,
    `Current time: ${formatDateTime(input.now, input.tz)} (${input.tz}).`,
    ``,
    `## How to answer`,
    `- Lead with the answer. Be concise: short paragraphs, bullets, or a compact table when comparing things. No filler and no restating the question.`,
    `- Cite web facts inline as [n], using only the source numbers you were given. Never invent sources, URLs, prices or dates.`,
    `- For anything time-sensitive (prices, versions, news), say when it was true ("as of 12 Nov 2026") and keep the user's timezone in mind.`,
    `- If sources disagree or are thin, say so in one line rather than guessing.`,
    `- Call web_search when the answer depends on current or specific facts not already in EVIDENCE. Skip it for small talk or what EVIDENCE already covers. Use specific queries; pass "after" (YYYY-MM-DD) to limit results to recent pages.`,
    ``,
    `## Memory`,
    `- MEMORY holds past conversations retrieved for this message, with their dates. Treat them as what actually happened and refer to them by date ("On Mon 3 Nov you asked…").`,
    `- If MEMORY says nothing was found for a date, say so plainly and mention the nearest conversation if one is given. Never make up past conversations.`,
    `- If the user tells you something that contradicts older memory, the newer statement wins.`,
  ];
  if (input.verification) {
    parts.push(
      ``,
      `## Re-checking an earlier answer`,
      `VERIFICATION compares what you said before with today's evidence. Answer with: a one-line verdict; then each item as **Changed** (old → new), **Unchanged**, or **Couldn't verify**, with citations; then notable news since then, if any. Be explicit about what you could not verify. Don't repeat items that weren't asked about.`,
    );
  }
  if (input.memory) parts.push(``, `# MEMORY`, input.memory);
  if (input.verification) parts.push(``, `# VERIFICATION`, input.verification);
  if (input.evidence) parts.push(``, `# EVIDENCE (web search, just now)`, input.evidence);
  return parts.join('\n');
}

export function formatMemory(r: RecallResult, tz: string): string | null {
  if (r.mode === 'none') return null;
  if (r.mode === 'range' && !r.exchanges.length) {
    const near = [r.nearest?.before, r.nearest?.after].filter((e): e is Exchange => !!e)
      .map((e) => `- ${formatDateTime(new Date(e.createdAt), e.tz)}: "${truncate(e.question, 160)}"`);
    return `No conversation found for ${r.range!.label}.` + (near.length ? `\nNearest conversations:\n${near.join('\n')}` : '\nThere are no earlier conversations at all.');
  }
  const header = r.mode === 'range'
    ? `Conversations from ${r.range!.label} (${r.exchanges.length}):`
    : `Possibly related earlier conversations:`;
  const blocks = r.exchanges.map((e) => {
    const facts = r.facts.get(e.userTurnId);
    const srcs = e.sources.slice(0, 3).map((s) => s.title).join('; ');
    return [
      `### ${formatDateTime(new Date(e.createdAt), tz)}`,
      `User asked: ${truncate(e.question, 600)}`,
      e.answer ? `You answered: ${truncate(e.answer, 1800)}` : `(no answer recorded)`,
      facts?.length ? `Notes: ${facts.join(' | ')}` : '',
      srcs ? `Sources you used then: ${srcs}` : '',
    ].filter(Boolean).join('\n');
  });
  return `${header}\n\n${blocks.join('\n\n')}`;
}
