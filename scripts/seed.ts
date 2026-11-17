/**
 * npm run seed — create realistic backdated history by running real questions
 * through the real agent with a simulated clock. Answers, sources and claims are
 * genuine (fetched today); only their timestamps are in the past.
 *
 *   npm run seed            # refuses if history already exists
 *   npm run seed -- --force # add the seed conversations anyway
 */
import { assertConfig, config } from '../src/config.js';
import { withNow, now } from '../src/clock.js';
import { countTurns } from '../src/db/repo.js';
import { runTurn } from '../src/agent/turn.js';
import '../src/jobs/handlers.js';
import { drain, startWorker, stopWorker } from '../src/jobs/queue.js';
import { formatDateTime } from '../src/time/tz.js';
import { seedHistory } from './history.js';

const problems = assertConfig();
if (problems.length) {
  console.error(`Cannot seed:\n- ${problems.join('\n- ')}\nCopy .env.example to .env and add your keys.`);
  process.exit(1);
}
const force = process.argv.includes('--force');
if (countTurns() > 0 && !force) {
  console.error('History already exists. Run `npm run seed -- --force` to add the seed conversations anyway.');
  process.exit(1);
}

const tz = process.env.USER_TZ ?? config.timezone;
const turns = seedHistory(now(), tz);
const threads = new Map<string, string>();
startWorker();

console.log(`Seeding ${turns.length} backdated questions (timezone ${tz}). This makes real model and search calls.\n`);
for (const t of turns) {
  process.stdout.write(`${formatDateTime(t.at, tz)}  ${t.message.slice(0, 70)}… `);
  const t0 = Date.now();
  let conversationId = threads.get(t.thread);
  const result = await withNow(t.at, () => runTurn({ message: t.message, tz, conversationId }, (e) => {
    if (e.type === 'meta') conversationId = e.conversationId;
    if (e.type === 'error') process.stdout.write(`\n  error: ${e.message}\n`);
  }));
  if (conversationId) threads.set(t.thread, conversationId);
  console.log(result.turnId ? `done in ${((Date.now() - t0) / 1000).toFixed(1)}s` : 'FAILED');
  await drain(); // extract claims before the next question, as would happen in real time
}
stopWorker();
console.log('\nSeeded. Start the app with `npm run dev` and try:');
console.log('  - "On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?"');
console.log('  - "What did I ask you on 3 November? Is your answer still correct today?"');
console.log('  - "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"');
process.exit(0);
