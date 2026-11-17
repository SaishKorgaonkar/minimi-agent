import { readFileSync } from 'node:fs';

/**
 * Model instructions that are tuned by measurement live in `prompts/*.md`, not
 * in code, so `npm run optimize` can swap candidates in and a winning prompt
 * lands as a reviewable diff. Read once per process.
 */
export type PromptName = 'router' | 'judge';

const cache = new Map<PromptName, string>();

export function prompt(name: PromptName): string {
  let text = cache.get(name);
  if (text === undefined) {
    text = readFileSync(new URL(`../prompts/${name}.md`, import.meta.url), 'utf8').trim();
    cache.set(name, text);
  }
  return text;
}
