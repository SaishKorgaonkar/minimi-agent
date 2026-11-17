import { createOpenAI } from '@ai-sdk/openai';
import { embed, embedMany, type EmbeddingModel, type LanguageModel } from 'ai';
import { config } from './config.js';
import { log } from './log.js';

/**
 * All model access goes through here. Swapping provider (e.g. Claude via
 * @ai-sdk/anthropic) means changing this file only.
 */
const openai = createOpenAI({ apiKey: config.keys.openai });

export type ModelRole = 'answer' | 'router' | 'extract';

/** Test seam: tests swap in mock models; production never sets these. */
const overrides: Partial<Record<ModelRole | 'embed', unknown>> = {};
export function setTestModels(m: Partial<{ answer: LanguageModel; router: LanguageModel; extract: LanguageModel; embed: EmbeddingModel }>) {
  Object.assign(overrides, m);
}

export const models = {
  answer: () => (overrides.answer as LanguageModel) ?? openai(config.models.answer),
  router: () => (overrides.router as LanguageModel) ?? openai(config.models.router),
  extract: () => (overrides.extract as LanguageModel) ?? openai(config.models.extract),
};

/**
 * Low reasoning effort on every path by default: routing and extraction are
 * classification, and the answer model works from evidence we already gathered.
 * If a model rejects these options, we drop them for that role and retry once.
 */
const effort = (process.env.REASONING_EFFORT ?? 'low') as 'none' | 'low' | 'medium' | 'high';
const optionsDisabled = new Set<ModelRole>();

export function providerOptions(role: ModelRole) {
  if (optionsDisabled.has(role) || process.env.REASONING_EFFORT === 'off') return undefined;
  return role === 'answer'
    ? { openai: { reasoningEffort: effort, textVerbosity: 'medium' as const } }
    : { openai: { reasoningEffort: effort } };
}

export function isOptionsError(err: unknown): boolean {
  return /reasoning|verbosity|unsupported (parameter|value)/i.test(String((err as Error)?.message ?? err));
}

export function disableOptions(role: ModelRole, err: unknown) {
  if (!optionsDisabled.has(role)) {
    log.warn({ role, err: String((err as Error)?.message ?? err) }, 'model rejected reasoning options; retrying without them');
    optionsDisabled.add(role);
  }
}

/** Run a non-streaming model call; if the provider rejects our options, retry once without them. */
export async function withOptionsFallback<T>(role: ModelRole, call: (opts: ReturnType<typeof providerOptions>) => Promise<T>): Promise<T> {
  try {
    return await call(providerOptions(role));
  } catch (err) {
    if (!isOptionsError(err) || optionsDisabled.has(role)) throw err;
    disableOptions(role, err);
    return call(undefined);
  }
}

const embeddingModel = () => (overrides.embed as EmbeddingModel) ?? openai.embeddingModel(config.models.embed);

export async function embedText(text: string): Promise<number[]> {
  const { embedding } = await embed({ model: embeddingModel(), value: text.slice(0, 8000) });
  return embedding;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (!texts.length) return [];
  const { embeddings } = await embedMany({ model: embeddingModel(), values: texts.map((t) => t.slice(0, 8000)) });
  return embeddings;
}
