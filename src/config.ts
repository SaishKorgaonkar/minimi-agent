import 'dotenv/config';

function num(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export const config = {
  port: num('PORT', 3000),
  dataDir: process.env.DATA_DIR ?? './data',
  /** Default timezone when the browser doesn't send one. */
  timezone: process.env.USER_TZ ?? systemTimezone(),

  models: {
    /** Writes the answer the user reads. */
    answer: process.env.MODEL_ANSWER ?? 'gpt-6.1-sol',
    /** Routing and query planning: runs on every turn, so it must be fast. */
    router: process.env.MODEL_ROUTER ?? 'gpt-6-luna',
    /** Background extraction and claim verification: structured output. */
    extract: process.env.MODEL_EXTRACT ?? 'gpt-6.1-terra',
    embed: process.env.MODEL_EMBED ?? 'text-embedding-3-small',
  },
  embedDims: 1536,

  search: {
    /** Wait at most this long for providers; use whatever has arrived. */
    providerTimeoutMs: num('SEARCH_TIMEOUT_MS', 1800),
    /** Per-page fetch timeout. */
    fetchTimeoutMs: num('FETCH_TIMEOUT_MS', 2500),
    resultsPerProvider: 6,
    /** Results handed to the model per search. */
    maxResults: 8,
    /** Pages fetched in full when the provider returned no page text. */
    maxFetch: 4,
    exaType: process.env.EXA_SEARCH_TYPE ?? 'lite',
  },

  agent: {
    /** Model steps in the answer loop (each tool call + final answer counts). */
    maxSteps: 4,
    recentTurns: 8,
    routerTimeoutMs: num('ROUTER_TIMEOUT_MS', 2500),
  },

  jobs: {
    pollMs: 400,
    maxAttempts: 4,
    /** How long after an answer its claims get re-checked (0 disables). */
    recheckAfterMs: num('RECHECK_AFTER_HOURS', 24) * 3_600_000,
  },

  keys: {
    openai: process.env.OPENAI_API_KEY ?? '',
    exa: process.env.EXA_API_KEY ?? '',
    tavily: process.env.TAVILY_API_KEY ?? '',
    brave: process.env.BRAVE_API_KEY ?? '',
  },

  /** Lets tests and the seed script send `x-now` to simulate a different date. */
  allowClockOverride: process.env.ALLOW_CLOCK_OVERRIDE !== 'false',
};

export function assertConfig(): string[] {
  const problems: string[] = [];
  if (process.env.NODE_ENV === 'test') return problems;
  if (!config.keys.openai) problems.push('OPENAI_API_KEY is missing');
  if (!config.keys.exa && !config.keys.tavily && !config.keys.brave) {
    problems.push('No search provider key: set EXA_API_KEY (or TAVILY_API_KEY / BRAVE_API_KEY)');
  }
  return problems;
}
