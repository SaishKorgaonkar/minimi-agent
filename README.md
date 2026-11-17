# Chat agent with web search and dated memory

A chat agent with one tool, web search. It answers with citations, remembers
what you asked and **when**, and can check whether an old answer is still true.

> "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?"

works because "last Tuesday" is resolved to an exact date range in code, that
day's conversation is recalled from a local SQLite memory, and the claims made
back then are re-checked against today's web, one by one.

See **[DESIGN.md](DESIGN.md)** for how it works and why.

## Run it

```bash
npm install
cp .env.example .env       # add OPENAI_API_KEY and EXA_API_KEY
npm run dev                # http://localhost:3000
```

Requires Node 22+. Data lives in `./data/agent.db` (one SQLite file; delete it to reset).

### Try the memory without waiting a week

```bash
npm run seed
```

This runs real questions through the agent with a simulated clock: a CRM shortlist "on Monday",
a Postgres hosting comparison "last Tuesday", a Node.js question "on 3 November", and so on.
Answers and sources are real; only the timestamps are in the past. Then ask:

- *On Monday we shortlisted 5 CRM tools for a 20-person sales team. Has any of them changed pricing or shipped something big since?*
- *What did I ask you on 3 November? Is your answer still correct today?*
- *Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?*

Each answer links to a **trace** page showing the route chosen, the searches run, timings and sources.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server + UI with reload |
| `npm run seed` | Backdated history through the real agent |
| `npm test` | Offline tests (mock models, fake search): date resolution, the full recall → verify flow, durable job queue |
| `npm run eval` | End-to-end eval on real models: LongMemEval's five memory abilities + re-verification + latency |
| `npm run eval:search` | Search provider freshness comparison (`-- --judge` adds relevance scoring) |
| `npm run typecheck` | TypeScript |

## Layout

```
src/
  server.ts            HTTP + SSE streaming (Hono)
  agent/turn.ts        one chat turn, end to end
  agent/router.ts      fast model: what does this turn need, and the first search
  agent/prompts.ts     system prompt, memory formatting
  time/resolve.ts      "last Tuesday" → exact range (deterministic)
  memory/recall.ts     recall by date range, or hybrid keyword + embedding search
  search/              providers (Exa, Tavily, Brave), fan-out, fusion, page fetch
  claims/              claim extraction and re-verification
  jobs/                durable job queue + background handlers
  db/                  SQLite schema and the storage interface
public/                chat UI (no build step) and trace viewer
scripts/               seed, evals
test/                  offline tests
```
