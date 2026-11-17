# Design

## The problem, restated

The example questions all have the same shape: **recall something from a date, then check it is still true.**
"On Monday we shortlisted 5 CRMs. Has any changed pricing since?" needs four things: resolve "Monday" to a
date, find that conversation, know *what was claimed* in it, and look for changes *since then*. LongMemEval
covers the memory half and search benchmarks cover freshness. Nothing covers both, so that's what this is built for.

## How a turn works

```
question ─► save (time + timezone) ─► resolve dates in code ─► route ‖ recall ─► gather evidence ─► stream answer ─► save + enqueue jobs
                                         "last Tuesday" →        fast model    verify old claims     gpt-6.1-sol,       index, extract
                                         exact [start, end)      + memory      or run first search   ≤3 more searches   claims, snapshot
```

1. **Dates are resolved by code, not the model** (`time/resolve.ts`). The user's timezone comes from the browser.
   LLMs are unreliable at calendar maths, and LongMemEval's biggest temporal gain came from narrowing retrieval to the right time window.
2. **Routing and recall run in parallel.** A fast model (`gpt-6-luna`) picks *chat / search / recall / recall+verify*
   and writes the first search queries. That search runs **before** the answer model starts, saving a model round trip.
3. **Recall** (`memory/recall.ts`): with a date range, every exchange in it is recalled, because "what did I ask on 3 Nov?"
   has no word overlap with the answer, so ranking alone would miss it. Without a date, hybrid search runs over turns *and* extracted facts
   (FTS5 + embeddings, reciprocal rank fusion). If a date has nothing, the prompt says so and names the nearest conversation, so the model doesn't make one up.
4. **Re-verification** (`claims/verify.ts`): after every answer, a background job extracts **claims**
   (`entity, attribute, value, source, checked_at`) and snapshots their source pages. "Still correct?" then becomes: re-fetch each
   source and compare it with the snapshot (an identical hash means unchanged, no LLM needed), search for news since that date, and have one judge call per
   entity mark each claim *changed / unchanged / couldn't verify*. Changed claims get a new version and the old one is kept (`superseded_by`).
   This matters because **pricing pages change without a new publish date**, so a date-filtered search alone misses them.
5. **One tool, `web_search`.** Each provider configured in `.env` (Exa, Tavily, Brave) is queried in parallel under a time cap, and the run continues with whichever providers answered.
   Results are merged by normalised URL and reciprocal rank fusion, with a recency boost inside date windows and at most 2 results per domain.
   Pages are fetched only when the provider returned no text. Sources are numbered once per turn, so citations stay stable.
6. **Durable background jobs** (`jobs/queue.ts`, ~100 lines on SQLite) are enqueued in the same transaction as the answer.
   Steps are saved, so a crash resumes a job instead of repeating paid LLM calls. Retries back off. A scheduled job re-checks old claims
   and creates a **nudge only when something changed** ("quiet the rest of the time").

## Why these choices

| Choice | Why |
|---|---|
| SQLite (WAL, FTS5, sqlite-vec), one local file | Memory is local and inspectable, like an on-device Mac app. The worker and server share it. No setup for reviewers. |
| Memory as context, not a second tool | Keeps the one-tool rule, saves a round trip, and recall is never skipped by a model that "forgot" to call it |
| Facts indexed *alongside* raw turns | LongMemEval: facts alone lose information; added to the index, they improve recall |
| Claims + snapshots | Turns "is it still true?" into a comparison instead of a vague re-search |
| Fast model routes, strong model answers | Routing runs every turn, so it must be fast and cheap; quality matters where the user reads |
| Vercel AI SDK | Provider-agnostic: switching to Claude is a change in `llm.ts` |
| Traces table + `/debug/turn/:id` | Every answer shows its route, searches, timings and sources |

## Considered and rejected

- **OpenAI's built-in web search**: convenient, but it hides retrieval, which is where the quality comes from.
- **Postgres / PGlite**: good features (`tstzrange`, pgvector) but a server to run, or a young single-connection embed. SQLite fits local-first better.
- **A vector database**: brute-force cosine inside a date filter is enough for one person's history. A `vec0` ANN index is the next step at scale.
- **A memory tool the model calls**: an extra round trip, and the model may not call it.
- **Sending the whole history as context**: LongMemEval shows long context isn't memory, and it gets slower and costlier with every turn.
- **Inngest / Temporal**: real durable execution, but an extra dev server for reviewers. The SQLite queue covers what's needed.
- **Speculative search on the raw message** (before routing): faster, but follow-ups like "has any of them changed?" make poor queries.

## Measured

`npm run eval` (real models: LongMemEval's five abilities + re-verification + fresh search, judged and checked) and
`npm run eval:search` (provider freshness: latency, dated results, date-filter compliance) write their tables to `data/eval/`.

<!-- Paste data/eval/results.md and data/eval/search.md summaries here after running. -->

## With another week

- **Proactive by default**: re-check on a schedule tuned per claim type (prices weekly, versions monthly) and send nudges to the Mac notification centre.
- **Cloudflare Agents SDK / Durable Objects**: one agent per user with its own SQLite, scheduling and WebSockets. The design maps one-to-one.
- **Headless fetch** for JavaScript-rendered pricing pages, which today come back "couldn't verify".
- **Structured diffs of snapshots** (price tables → JSON), so "what changed" doesn't need an LLM at all.
- **A bigger eval set** built from real usage, and A/B runs of search providers and models from the same harness.
