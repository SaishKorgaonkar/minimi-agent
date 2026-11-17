import { generateText, Output } from 'ai';
import { z } from 'zod';
import { models, withOptionsFallback } from '../llm.js';
import type { Source } from '../db/repo.js';
import { formatDateTime } from '../time/tz.js';

/**
 * After an answer streams, a background job turns the exchange into:
 *  - facts: short, self-contained memory notes (indexed next to the raw turn)
 *  - claims: checkable statements about the world, each tied to a source
 * Claims are what make "is your answer still correct?" a lookup instead of a guess.
 */

const schema = z.object({
  facts: z.array(z.string()).describe(
    'Up to 6 short standalone notes worth remembering: what the user asked or decided, their context (team size, budget, constraints), and the key conclusions. Each must make sense alone, with names spelled out.',
  ),
  claims: z.array(z.object({
    entity: z.string().describe('Product, company or thing, e.g. "Neon" or "HubSpot Sales Hub"'),
    attribute: z.string().describe('What about it, e.g. "Launch plan price" or "latest major release"'),
    value: z.string().describe('The value the answer stated, e.g. "$19/month" — copy it, never invent'),
    source: z.number().nullable().describe('Number of the source [n] that supports it, or null'),
  })).describe(
    'Up to 15 factual claims from the ANSWER about the outside world that could change over time (prices, plans, limits, versions, features, availability, people in roles). Skip opinions and timeless facts.',
  ),
});

export type Extraction = z.infer<typeof schema>;

export async function extractFromExchange(input: {
  question: string;
  answer: string;
  sources: Source[];
  at: Date;
  tz: string;
}): Promise<Extraction> {
  const sourceList = input.sources.map((s) => `[${s.n}] ${s.title} — ${s.url}`).join('\n') || '(no web sources)';
  const { output } = await withOptionsFallback('extract', (providerOptions) =>
    generateText({
      model: models.extract(),
      providerOptions,
      output: Output.object({ schema }),
      instructions:
        'You turn a chat exchange into memory notes and checkable claims. Be literal: only record what was said. ' +
        'Claims must come from the assistant answer and keep the exact values it gave.',
      prompt:
        `Exchange time: ${formatDateTime(input.at, input.tz)} (${input.tz})\n\n` +
        `USER:\n${input.question}\n\nASSISTANT:\n${input.answer}\n\nSOURCES:\n${sourceList}`,
    }),
  );
  return {
    facts: (output?.facts ?? []).slice(0, 6),
    claims: (output?.claims ?? []).slice(0, 15),
  };
}
