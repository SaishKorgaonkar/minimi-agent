import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { log } from '../log.js';
import { id, json } from '../util.js';

/**
 * A durable job queue on SQLite, about 100 lines.
 *
 * - enqueue() is called inside the same transaction that saves the turn, so a
 *   crash can never leave an answer without its indexing/extraction job.
 * - Each job runs as named steps. A finished step's result is saved in `steps`;
 *   after a crash or retry the job resumes from the first unfinished step
 *   (so an expensive LLM extraction isn't paid for twice).
 * - Retries back off exponentially; after maxAttempts the job is marked failed.
 * - A job with a future run_at is a scheduled job (claim re-checks).
 */

export type JobType = 'index_turn' | 'extract_claims' | 'snapshot_sources' | 'recheck_claims';

export interface Job {
  id: string;
  type: JobType;
  payload: string;
  status: string;
  attempts: number;
  run_at: number;
  steps: string;
}

export interface StepContext {
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  payload: any;
  jobId: string;
}

type Handler = (ctx: StepContext) => Promise<void>;
const handlers = new Map<JobType, Handler>();

export function registerHandler(type: JobType, handler: Handler) {
  handlers.set(type, handler);
}

/** Wall-clock time: jobs run in real time even when a request simulates another date. */
const realNow = () => Date.now();

export function enqueue(type: JobType, payload: unknown, runAt = realNow()): string {
  const jid = id('job');
  const t = realNow();
  getDb()
    .prepare(`INSERT INTO jobs (id, type, payload, run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(jid, type, JSON.stringify(payload), runAt, t, t);
  return jid;
}

function claimNext(): Job | undefined {
  // Single statement, so two workers can never take the same job.
  return getDb()
    .prepare(`UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ?
              WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND run_at <= ? ORDER BY run_at ASC LIMIT 1)
              RETURNING *`)
    .get(realNow(), realNow()) as Job | undefined;
}

async function runJob(job: Job) {
  const handler = handlers.get(job.type);
  const db = getDb();
  if (!handler) {
    db.prepare(`UPDATE jobs SET status = 'failed', last_error = ? WHERE id = ?`).run(`no handler for ${job.type}`, job.id);
    return;
  }
  const done = json<Record<string, unknown>>(job.steps, {});
  const ctx: StepContext = {
    jobId: job.id,
    payload: json(job.payload, {}),
    async step<T>(name: string, fn: () => Promise<T>): Promise<T> {
      if (name in done) return done[name] as T;
      const result = await fn();
      done[name] = result ?? null;
      db.prepare('UPDATE jobs SET steps = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(done), realNow(), job.id);
      return result;
    },
  };
  try {
    await handler(ctx);
    db.prepare(`UPDATE jobs SET status = 'done', updated_at = ? WHERE id = ?`).run(realNow(), job.id);
  } catch (err) {
    const message = String((err as Error)?.stack ?? err).slice(0, 2000);
    if (job.attempts >= config.jobs.maxAttempts) {
      db.prepare(`UPDATE jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE id = ?`).run(message, realNow(), job.id);
      log.error({ job: job.id, type: job.type, err: message }, 'job failed permanently');
    } else {
      const backoff = 2 ** job.attempts * 1000;
      db.prepare(`UPDATE jobs SET status = 'pending', run_at = ?, last_error = ?, updated_at = ? WHERE id = ?`)
        .run(realNow() + backoff, message, realNow(), job.id);
      log.warn({ job: job.id, type: job.type, attempt: job.attempts, err: message.split('\n')[0] }, 'job failed; will retry');
    }
  }
}

let running = false;
let timer: NodeJS.Timeout | undefined;
let active = 0;
const CONCURRENCY = 3;

/** Start the in-process worker. Jobs left 'running' by a crash are put back in the queue. */
export function startWorker() {
  if (running) return;
  running = true;
  const reset = getDb().prepare(`UPDATE jobs SET status = 'pending' WHERE status = 'running'`).run();
  if (reset.changes) log.info({ jobs: reset.changes }, 'resuming jobs interrupted by a restart');
  const tick = () => {
    if (!running) return;
    while (active < CONCURRENCY) {
      const job = claimNext();
      if (!job) break;
      active++;
      runJob(job).finally(() => { active--; });
    }
    timer = setTimeout(tick, config.jobs.pollMs);
  };
  tick();
}

export function stopWorker() {
  running = false;
  clearTimeout(timer);
}

/**
 * Wait until no due or retrying jobs remain (used by the seed and eval scripts).
 * Scheduled jobs that haven't run yet (future re-checks) are not waited for.
 */
export async function drain(timeoutMs = 120_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM jobs
                WHERE status = 'running' OR (status = 'pending' AND (run_at <= ? OR attempts > 0))`)
      .get(realNow()) as { n: number };
    if (r.n === 0 && active === 0) return;
    await new Promise((res) => setTimeout(res, 250));
  }
}

export function jobStats() {
  return getDb().prepare('SELECT type, status, COUNT(*) AS n FROM jobs GROUP BY type, status').all();
}
