# Design

## The problem

Every example question has the same shape: **recall something from a date, then check it is still true.**
"On Monday we shortlisted 5 CRMs. Has any changed pricing since?" means resolving "Monday", finding that conversation,
knowing *what was claimed* in it, and looking for changes *since then*. LongMemEval covers the memory half and search
benchmarks cover freshness. This is built for both together.

## How a turn works

```
save question ─► resolve dates (code) ─► route ‖ recall ─► gather evidence ─► stream answer ─► save + enqueue jobs
                 "last Tue" → [start,end)  gpt-6-luna   re-check old claims   gpt-6.1-sol      index, extract claims,
                                           + memory     or first search       may search again snapshot sources
```

1. **Dates are resolved in code** (`time/resolve.ts`), in the browser's timezone. LLMs are unreliable at calendar maths, and
   LongMemEval's largest temporal gain came from narrowing retrieval to the right window.
2. **Routing and recall run in parallel.** The router picks *chat / search / recall / recall+verify* and writes the first
   queries, which run **before** the answer model starts. If it is slow, a regex fallback decides. The user's country (from the
   browser's timezone, then language) goes to the router, the search providers and the prompt, so prices come in local currency and stores.
3. **Recall** (`memory/recall.ts`): a date returns every exchange that day ("what did I ask on 3 Nov?" shares no words with
   the answer). Otherwise hybrid search (FTS5 + embeddings, rank fusion) runs over turns *and* extracted facts. An empty date
   is said out loud, along with the nearest real conversation, so nothing is invented. A question about the world only gets memory that is close in meaning
   (cosine ≤ 0.5), so "latest pricing" for a game doesn't surface a CRM chat; keyword matches count when asking about our past.
4. **Re-verification** (`claims/verify.ts`): after each answer, a job extracts **claims** (`entity, attribute, value,
   source, checked_at`) and snapshots their sources. "Still correct?" re-fetches each source (an identical hash means
   unchanged, no LLM), searches current state and news since the date per vendor, and **one batched judge call** marks each
   claim *changed / unchanged / couldn't verify*. Changed claims get a new version and the old one is kept (`superseded_by`).
   Pricing pages change without a new publish date, so a date-filtered search alone would miss it.
5. **One tool, `web_search`.** Exa, Tavily and Brave (whichever keys are set) run in parallel under a deadline. Requests queue per
   provider, and slow providers get a 400 ms grace once every query has results. Results are merged by URL with reciprocal rank
   fusion, a recency boost inside date windows, and at most 2 per domain. Sources are numbered once per turn.
6. **Durable jobs** (`jobs/queue.ts`, SQLite) are enqueued in the answer's transaction. Completed steps are saved, so a crash
   doesn't repeat paid calls. No job starts while a chat turn runs. A scheduled re-check **nudges only when something changed**.

## Why these choices

| Choice | Why |
|---|---|
| SQLite (WAL, FTS5, sqlite-vec), one file | Local and inspectable like an on-device app; worker and server share it; no setup for reviewers |
| Memory as context, not a second tool | Keeps the one-tool rule, saves a round trip, never skipped by a model that "forgot" |
| Facts indexed *alongside* raw turns | LongMemEval: facts alone lose information; added to the index they improve recall |
| Claims + snapshots | "Is it still true?" becomes a comparison, not a vague re-search |
| Fast router, strong answerer | Routing runs every turn; quality matters where the user reads |
| Vercel AI SDK, traces at `/debug/turn/:id` | Provider swap is one file; every answer shows its route, searches and timings |

**Rejected:** OpenAI's built-in search (hides retrieval). Postgres/PGlite (a server to run). A vector database (cosine inside a
date filter is enough for one person). A memory tool (an extra round trip). Whole history in context (long context isn't memory).
Inngest/Temporal (an extra dev server).

## Measured (real models and search, 17 Nov 2026)

`npm run eval`: LongMemEval's five abilities, two re-verifications, fresh search and small talk, checked in code and by an
LLM judge. **9/9 pass. First word p50 3.7 s.**

| Kind of turn | First word | Total |
|---|---|---|
| Recall, knowledge update, abstention, small talk | 2.7–3.8 s | 3.7–7.4 s |
| Fresh web search | 4.8 s | 15.4 s |
| Re-verify 4–5 vendors against today's web | 15.6–16.6 s | 19.7–21.3 s |

`npm run eval:search -- --judge` (10 dated news queries): **Exa** p50 0.5 s, 100% dated, 100% in window, 73% relevant.
**Tavily** p50 1.4 s (p90 3.4 s), 82% dated, 100% in window, 48% relevant.

**What running it live changed** (each measured, then fixed):
- Free-tier search keys serve only a few requests at once (Exa ~4, Tavily ~1). Re-checking 6 vendors sent 24 searches and all
  timed out. Hence the per-provider queues, and claims grouped by vendor with two queries each.
- Concurrent OpenAI calls on one key came back one at a time (5 judges finishing ~3 s apart). Hence one batched judge call,
  and the worker pausing during turns. Without the pause, back-to-back questions had a first word p50 of 12 s.
- The router at reasoning `none` takes 1.3–2.4 s instead of 3.4–4.4 s, with the same accuracy. Re-verification starts speculatively
  while it routes, when the date matched a stored conversation and the question plainly asks "has this changed?".
- Exa `lite` rejects `maxAgeHours`, so freshness comes from re-fetching the page. "Tue, 3 Nov" resolved to last Tuesday;
  an explicit date now wins.

**Prompt optimisation** (`scripts/optimize/`, after [GEPA](https://github.com/gepa-ai/gepa)). The router scored 47/48 on a labelled set
before any tuning; its misses are API latency, not wording, so it was left alone. For the judge, 23 cases with known answers were built from real
claims and page snapshots, split by vendor into train/val/test. Two optimisers got the same scorer, models and budget (120 evaluations): a GEPA-style loop in
TypeScript (`npm run optimize`), and real GEPA through a Python bridge that scores every candidate with the same TypeScript rollout. Both kept
the original as best on validation. GEPA's strongest rewrite had good general rules but memorised training cases (1.0 on train, 0.90 overall).
Keeping only its general rules gave **0.95 vs 0.88** over 4 runs on all 23 cases (test 0.97 vs 0.86) with no false "changed"; that is `prompts/judge.md`.
Building the labels also exposed a real bug: claims grouped by vendor had lost their plan names ("Pipedrive Growth" vs "Lite").

**Known gaps:** a re-check recalls only that day, so a later update ("the team is now 35") isn't weighed. Pages that render
prices with JavaScript come back "couldn't verify".

## With another week

Re-checks scheduled per claim type, with Mac notifications. One Durable Object per user (the design maps one-to-one).
Headless fetch for JavaScript pricing pages. Larger, human-checked eval sets from real usage, so the optimiser can tune the answer prompt too.
