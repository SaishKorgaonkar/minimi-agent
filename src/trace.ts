import { insertTrace } from './db/repo.js';
import { log } from './log.js';

/**
 * Per-turn tracer. Spans are buffered in memory and written once the turn ends,
 * so tracing never sits on the path to the first token.
 */
export class Tracer {
  private spans: { step: string; startedAt: number; durationMs: number | null; data: unknown }[] = [];
  private readonly t0 = performance.now();
  readonly marks: Record<string, number> = {};

  constructor(public turnId: string) {}

  /** Milliseconds since the turn started. */
  elapsed(): number {
    return Math.round(performance.now() - this.t0);
  }

  mark(name: string) {
    this.marks[name] ??= this.elapsed();
  }

  event(step: string, data?: unknown) {
    this.spans.push({ step, startedAt: Date.now(), durationMs: null, data });
  }

  async span<T>(step: string, fn: () => Promise<T>, summarize?: (r: T) => unknown): Promise<T> {
    const startedAt = Date.now();
    const s = performance.now();
    try {
      const r = await fn();
      this.spans.push({ step, startedAt, durationMs: Math.round(performance.now() - s), data: summarize ? summarize(r) : undefined });
      return r;
    } catch (err) {
      this.spans.push({ step, startedAt, durationMs: Math.round(performance.now() - s), data: { error: String(err) } });
      throw err;
    }
  }

  flush() {
    try {
      for (const s of this.spans) insertTrace({ turnId: this.turnId, ...s });
      insertTrace({ turnId: this.turnId, step: 'timings', startedAt: Date.now(), durationMs: this.elapsed(), data: this.marks });
    } catch (err) {
      log.warn({ err: String(err) }, 'trace flush failed');
    }
    this.spans = [];
  }
}
