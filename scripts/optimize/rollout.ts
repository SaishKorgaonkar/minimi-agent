/**
 * Evaluate one candidate prompt on a set of examples and print JSON results.
 * Used by the Python GEPA bridge (stdin → stdout) and for scoring seeds and
 * winners on the held-out test split.
 *
 *   echo '{"task":"router","instructions":"…","split":"val"}' | tsx scripts/optimize/rollout.ts
 *   echo '{"task":"judge","instructions":"…","ids":["judge:neon-0"]}' | tsx scripts/optimize/rollout.ts
 */
import 'dotenv/config';
import { describeInput, runExamples, tasks, type Split, type TaskName } from './tasks.js';

const input = JSON.parse(await new Promise<string>((res) => {
  let s = '';
  process.stdin.on('data', (d) => (s += d)).on('end', () => res(s));
})) as { task: TaskName; instructions?: string; split?: Split; ids?: string[]; list?: boolean };

const task = tasks[input.task];
const all = task.examples();
if (input.list) {
  // For the Python bridge: example ids, splits, readable inputs, and the seed prompt.
  process.stdout.write(JSON.stringify({ seed: task.seed(), examples: all.map((e) => ({ id: e.id, split: e.split, input: describeInput(input.task, e.input) })) }));
  process.exit(0);
}
const examples = input.ids ? all.filter((e) => input.ids!.includes(e.id)) : all.filter((e) => !input.split || e.split === input.split);
const results = await runExamples(input.task, input.instructions ?? task.seed(), examples);
process.stdout.write(JSON.stringify(results));
