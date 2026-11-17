/** The durable queue: a job that fails mid-way resumes after its last completed step. */
process.env.NODE_ENV = 'test';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { openDb, setDb, getDb } = await import('../src/db/index.js');
setDb(openDb(':memory:'));
const { enqueue, registerHandler, startWorker, stopWorker, drain } = await import('../src/jobs/queue.js');

test('completed steps are not re-run on retry', async () => {
  let expensiveCalls = 0;
  let attempts = 0;
  registerHandler('index_turn', async ({ step }) => {
    attempts++;
    const v = await step('expensive', async () => { expensiveCalls++; return 42; });
    assert.equal(v, 42);
    if (attempts === 1) throw new Error('simulated crash after the expensive step');
  });
  const id = enqueue('index_turn', {});
  startWorker();
  await drain(10_000);
  stopWorker();
  const job = getDb().prepare('SELECT * FROM jobs WHERE id = ?').get(id) as any;
  assert.equal(job.status, 'done');
  assert.equal(job.attempts, 2);
  assert.equal(attempts, 2);
  assert.equal(expensiveCalls, 1, 'the expensive step ran once, its result was reused');
});

test('jobs left running by a crash are resumed on start', async () => {
  let ran = 0;
  registerHandler('snapshot_sources', async () => { ran++; });
  const id = enqueue('snapshot_sources', { urls: [] });
  getDb().prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(id); // as if the process died mid-job
  startWorker();
  await drain(5_000);
  stopWorker();
  assert.equal(ran, 1);
  assert.equal((getDb().prepare('SELECT status FROM jobs WHERE id = ?').get(id) as any).status, 'done');
});
