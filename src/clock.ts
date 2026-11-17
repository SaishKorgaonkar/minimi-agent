import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Injectable clock. Everything time-dependent calls `now()`, never `new Date()`.
 *
 * - `NOW=2026-11-03T10:00:00+05:30` (env) shifts the whole process to that moment;
 *   time still moves forward from there.
 * - `withNow(date, fn)` overrides the time for one request (the `x-now` header),
 *   which is how the seed script writes backdated history and evals run "on" a date.
 */
const storage = new AsyncLocalStorage<{ fixed: number }>();

const envOffset = (() => {
  const raw = process.env.NOW;
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t - Date.now() : 0;
})();

export function now(): Date {
  const ctx = storage.getStore();
  if (ctx) return new Date(ctx.fixed + (performance.now() - startPerf.get(ctx)!));
  return new Date(Date.now() + envOffset);
}

const startPerf = new WeakMap<{ fixed: number }, number>();

export function withNow<T>(date: Date, fn: () => T): T {
  const ctx = { fixed: date.getTime() };
  startPerf.set(ctx, performance.now());
  return storage.run(ctx, fn);
}

export function nowMs(): number {
  return now().getTime();
}
