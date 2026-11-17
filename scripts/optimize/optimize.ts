/**
 * GEPA-style prompt optimisation in TypeScript (after github.com/gepa-ai/gepa):
 *
 *   1. Score the seed prompt on the validation split.
 *   2. Pick a parent from the Pareto front: every candidate that is best on at
 *      least one validation example (weighted by how many), not just the top
 *      average, so different strengths survive.
 *   3. Run it on a minibatch of 3 training examples, keeping each example's
 *      written feedback.
 *   4. A strong model reads the prompt, inputs, outputs and feedback and writes
 *      a new prompt (GEPA's default reflection template).
 *   5. If the child beats the parent on that minibatch, score it on validation
 *      and add it to the pool.
 *
 * Budget = number of example evaluations, the same unit GEPA's max_metric_calls uses.
 * Merging two candidates (GEPA's "merge") is not implemented here.
 *
 *   npm run optimize -- judge --budget 120
 */
import 'dotenv/config';
import { generateText } from 'ai';
import { mkdirSync, writeFileSync } from 'node:fs';
import { models, providerOptions } from '../../src/llm.js';
import { describeInput, runExamples, tasks, type Example, type Result, type TaskName } from './tasks.js';

const task = (process.argv[2] ?? 'judge') as TaskName;
const budget = Number(process.argv[process.argv.indexOf('--budget') + 1] || 120);
const minibatch = 3;

interface Candidate { id: number; parent: number | null; text: string; val: Result[]; mean: number }

const all = tasks[task].examples();
const train = all.filter((e) => e.split === 'train');
const val = all.filter((e) => e.split === 'val');
let used = 0;
const log: string[] = [];
const say = (s: string) => { log.push(s); console.log(s); };

async function evaluate(text: string, examples: Example[]): Promise<Result[]> {
  used += examples.length;
  return runExamples(task, text, examples);
}

const mean = (rs: Result[]) => rs.reduce((s, r) => s + r.score, 0) / rs.length;

/** GEPA's default instruction-proposal template. */
function reflectionPrompt(current: string, batch: Example[], results: Result[]): string {
  const examples = batch.map((ex, i) =>
    `# Example ${i + 1}\n## Inputs\n${describeInput(task, ex.input)}\n## Generated Outputs\n${results[i].output}\n## Feedback\n${results[i].feedback}`).join('\n\n');
  return [
    'I provided an assistant with the following instructions to perform a task for me:',
    '```', current, '```', '',
    'The following are examples of different task inputs provided to the assistant along with the assistant\'s response for each of them, and some feedback on how the assistant\'s response could be better:',
    '```', examples, '```', '',
    'Your task is to write a new instruction for the assistant.', '',
    'Read the inputs carefully and identify the input format and infer detailed task description about the task I wish to solve with the assistant.', '',
    'Read all the assistant responses and the corresponding feedback. Identify all niche and domain specific factual information about the task and include it in the instruction, as a lot of it may not be available to the assistant in the future. The assistant may have utilized a generalizable strategy to solve the task, if so, include that in the instruction as well.', '',
    'Provide the new instructions within ``` blocks.',
  ].join('\n');
}

async function reflect(current: string, batch: Example[], results: Result[]): Promise<string | null> {
  const { text } = await generateText({ model: models.answer(), providerOptions: providerOptions('extract'), prompt: reflectionPrompt(current, batch, results) });
  const m = text.match(/```(?:[a-z]*\n)?([\s\S]*?)```/);
  const out = (m ? m[1] : text).trim();
  return out.length > 20 ? out : null;
}

/** Candidates best on at least one validation example, weighted by how many. */
function pickParent(pool: Candidate[]): Candidate {
  const wins = new Map<number, number>();
  val.forEach((_, i) => {
    const best = Math.max(...pool.map((c) => c.val[i].score));
    for (const c of pool) if (c.val[i].score === best) wins.set(c.id, (wins.get(c.id) ?? 0) + 1);
  });
  const front = pool.filter((c) => wins.has(c.id));
  let r = Math.random() * front.reduce((s, c) => s + wins.get(c.id)!, 0);
  for (const c of front) if ((r -= wins.get(c.id)!) <= 0) return c;
  return front[0];
}

const seedText = tasks[task].seed();
const seedVal = await evaluate(seedText, val);
const pool: Candidate[] = [{ id: 0, parent: null, text: seedText, val: seedVal, mean: mean(seedVal) }];
say(`[${task}] seed val ${pool[0].mean.toFixed(3)} · budget ${budget} · train ${train.length} · val ${val.length}`);

let cursor = 0;
let iteration = 0;
while (used + minibatch * 2 + val.length <= budget) {
  iteration++;
  const parent = pickParent(pool);
  const batch = Array.from({ length: minibatch }, () => train[cursor++ % train.length]);
  const before = await evaluate(parent.text, batch);
  if (before.every((r) => r.score === 1)) { say(`  it${iteration}: parent #${parent.id} perfect on minibatch, skip`); continue; }
  const childText = await reflect(parent.text, batch, before);
  if (!childText) { say(`  it${iteration}: reflection gave no prompt`); continue; }
  const after = await evaluate(childText, batch);
  const gain = after.reduce((s, r) => s + r.score, 0) - before.reduce((s, r) => s + r.score, 0);
  if (gain <= 0) { say(`  it${iteration}: child of #${parent.id} rejected on minibatch (${gain.toFixed(2)})`); continue; }
  const childVal = await evaluate(childText, val);
  const child: Candidate = { id: pool.length, parent: parent.id, text: childText, val: childVal, mean: mean(childVal) };
  pool.push(child);
  say(`  it${iteration}: child #${child.id} of #${parent.id} accepted (+${gain.toFixed(2)} minibatch) → val ${child.mean.toFixed(3)} · used ${used}/${budget}`);
}

const best = [...pool].sort((a, b) => b.mean - a.mean || a.text.length - b.text.length)[0];
say(`[${task}] best #${best.id} val ${best.mean.toFixed(3)} (seed ${pool[0].mean.toFixed(3)}) · ${pool.length} candidates · ${used} evaluations`);

mkdirSync('data/optimize', { recursive: true });
writeFileSync(`data/optimize/${task}-ts.json`, JSON.stringify({
  task, method: 'ts-gepa', budget, used, best: best.text, bestVal: best.mean, seedVal: pool[0].mean,
  pool: pool.map(({ val: _v, ...c }) => c), log,
}, null, 1));
