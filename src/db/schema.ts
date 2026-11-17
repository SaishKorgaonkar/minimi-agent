/**
 * Migrations, applied in order and tracked with PRAGMA user_version.
 * All timestamps are epoch milliseconds (UTC). Timezones are stored separately,
 * so "what did I ask on 3 Nov" is resolved in the user's calendar, not the server's.
 */
export const migrations: string[] = [
  /* 1: core memory */ `
  CREATE TABLE conversations (
    id          TEXT PRIMARY KEY,
    created_at  INTEGER NOT NULL,
    title       TEXT
  );

  CREATE TABLE turns (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    role            TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content         TEXT NOT NULL,
    reply_to        TEXT REFERENCES turns(id),       -- assistant turn → the user turn it answers
    sources         TEXT,                            -- JSON: sources cited by an assistant turn
    meta            TEXT,                            -- JSON: route, date range, timings
    created_at      INTEGER NOT NULL,
    tz              TEXT NOT NULL
  );
  CREATE INDEX turns_by_time ON turns(created_at);
  CREATE INDEX turns_by_conversation ON turns(conversation_id, created_at);
  CREATE INDEX turns_by_reply ON turns(reply_to);

  -- Searchable memory: one row per turn plus one per extracted fact.
  -- LongMemEval: index facts alongside raw turns, never instead of them.
  CREATE TABLE memory_items (
    id          INTEGER PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('turn', 'fact')),
    turn_id     TEXT NOT NULL REFERENCES turns(id),  -- the user turn of the exchange
    text        TEXT NOT NULL,
    embedding   BLOB,                                -- float32[dims]
    created_at  INTEGER NOT NULL                     -- time of the exchange, not of indexing
  );
  CREATE INDEX memory_by_time ON memory_items(created_at);
  CREATE INDEX memory_by_turn ON memory_items(turn_id);
  CREATE VIRTUAL TABLE memory_fts USING fts5(text, content='memory_items', content_rowid='id', tokenize='porter unicode61');
  CREATE TRIGGER memory_ai AFTER INSERT ON memory_items BEGIN
    INSERT INTO memory_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER memory_ad AFTER DELETE ON memory_items BEGIN
    INSERT INTO memory_fts(memory_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;

  -- Claims: what an answer asserted about the world, with when it was checked.
  -- Bi-temporal (borrowed from Zep/Graphiti): checked_at = when we learned it,
  -- superseded_by = a later claim replaced it. Old claims are never deleted.
  CREATE TABLE claims (
    id            TEXT PRIMARY KEY,
    turn_id       TEXT NOT NULL REFERENCES turns(id), -- assistant turn that made the claim
    entity        TEXT NOT NULL,
    attribute     TEXT NOT NULL,
    value         TEXT NOT NULL,
    source_url    TEXT,
    checked_at    INTEGER NOT NULL,
    superseded_by TEXT REFERENCES claims(id)
  );
  CREATE INDEX claims_by_turn ON claims(turn_id);
  CREATE INDEX claims_by_entity ON claims(entity COLLATE NOCASE, attribute);

  -- Every re-check of a claim, whatever the outcome.
  CREATE TABLE verifications (
    id          TEXT PRIMARY KEY,
    claim_id    TEXT NOT NULL REFERENCES claims(id),
    status      TEXT NOT NULL CHECK (status IN ('changed', 'unchanged', 'unverified')),
    new_value   TEXT,
    evidence    TEXT,                                -- JSON: [{url, title}]
    note        TEXT,
    checked_at  INTEGER NOT NULL
  );
  CREATE INDEX verifications_by_claim ON verifications(claim_id, checked_at);

  -- Page snapshots: lets "has the pricing page changed?" be answered by comparison.
  CREATE TABLE snapshots (
    id            TEXT PRIMARY KEY,
    url           TEXT NOT NULL,
    fetched_at    INTEGER NOT NULL,
    content_hash  TEXT NOT NULL,
    title         TEXT,
    text          TEXT NOT NULL                      -- normalised page text (capped)
  );
  CREATE INDEX snapshots_by_url ON snapshots(url, fetched_at);

  -- Durable job queue. Jobs are inserted in the same transaction as the turn they
  -- belong to; completed steps are recorded so a crashed job resumes, not restarts.
  CREATE TABLE jobs (
    id          TEXT PRIMARY KEY,
    type        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
    attempts    INTEGER NOT NULL DEFAULT 0,
    run_at      INTEGER NOT NULL,
    steps       TEXT NOT NULL DEFAULT '{}',
    last_error  TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX jobs_due ON jobs(status, run_at);

  -- One row per step of a turn: router decision, searches, latencies, tokens, errors.
  CREATE TABLE traces (
    id          INTEGER PRIMARY KEY,
    turn_id     TEXT NOT NULL,
    step        TEXT NOT NULL,
    started_at  INTEGER NOT NULL,
    duration_ms INTEGER,
    data        TEXT
  );
  CREATE INDEX traces_by_turn ON traces(turn_id);

  -- Proactive notices: a re-check found that something changed.
  CREATE TABLE nudges (
    id          TEXT PRIMARY KEY,
    claim_id    TEXT REFERENCES claims(id),
    summary     TEXT NOT NULL,
    sources     TEXT,
    created_at  INTEGER NOT NULL,
    seen_at     INTEGER
  );
  `,
];
