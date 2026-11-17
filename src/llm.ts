import { createOpenAI } from '@ai-sdk/openai';
import { embed, embedMany, type EmbeddingModel, type LanguageModel } from 'ai';
import { config } from './config.js';
import { log } from './log.js';

/**
 * All model access goes through here. Swapping provider (e.g. Claude via
 * @ai-sdk/anthropic) means changing this file only.
 */
const openai = createOpenAI({ apiKey: config.keys.openai });

export type ModelRole = 'answer' | 'router' | 'extract' | 'judge';

/** Test seam: tests swap in mock models; production never sets these. */
const overrides: Partial<Record<ModelRole | 'embed', unknown>> = {};
export function setTestModels(m: Partial<{ answer: LanguageModel; router: LanguageModel; extract: LanguageModel; judge: LanguageModel; embed: EmbeddingModel }>) {
  Object.assign(overrides, m);
}

export const models = {
  answer: () => (overrides.answer as LanguageModel) ?? openai(config.models.answer),
  router: () => (overrides.router as LanguageModel) ?? openai(config.models.router),
  extract: () => (overrides.extract as LanguageModel) ?? openai(config.models.extract),
  /** Re-verification judge: same model as extraction, no reasoning (it compares values in given evidence). */
  judge: () => (overrides.judge as LanguageModel) ?? (overrides.extract as LanguageModel) ?? openai(config.models.judge),
};

/**
 * Reasoning effort per role. Routing is classification, so it runs with none
 * (measured: ~1.5 s vs ~3.8 s at low on gpt-6-luna). Sol's minimum is low.
 * The verification judge compares values in given evidence, so none as well.
 * REASONING_EFFORT_<ROLE> or REASONING_EFFORT overrides; 'off' sends nothing.
 * If a model rejects these options, we drop them for that role and retry once.
 */
type Effort = 'none' | 'low' | 'medium' | 'high';
const defaultEffort: Record<ModelRole, Effort> = { router: 'none', judge: 'none', extract: 'low', answer: 'low' };
const optionsDisabled = new Set<ModelRole>();

function effortFor(role: ModelRole): Effort | 'off' {
  return (process.env[`REASONING_EFFORT_${role.toUpperCase()}`] ?? process.env.REASONING_EFFORT ?? defaultEffort[role]) as Effort | 'off';
}

export function providerOptions(role: ModelRole) {
  const effort = effortFor(role);
  if (optionsDisabled.has(role) || effort === 'off') return undefined;
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
