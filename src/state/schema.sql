-- Open Review SQLite schema (D-12, D-13).
-- All tables are idempotent (CREATE IF NOT EXISTS) so openDb can be called
-- on an existing database safely.

-- INTK dedup: one row per GitHub delivery GUID, pruned after 7 days.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

-- INCR-01: per-PR last successfully-reviewed head SHA. Drives incremental review
-- (diff lastReviewedSha..head instead of base..head on subsequent pushes).
CREATE TABLE IF NOT EXISTS pr_reviews (
  pr_id TEXT PRIMARY KEY,            -- owner/repo#number
  last_reviewed_sha TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- INCR-02: fingerprints of findings already surfaced on a PR, so the same issue
-- is not re-posted across pushes (comment dedup, ~90-day TTL).
CREATE TABLE IF NOT EXISTS posted_comments (
  pr_id TEXT NOT NULL,              -- owner/repo#number
  fingerprint TEXT NOT NULL,        -- sha1(file + normalized message)
  created_at TEXT NOT NULL,
  PRIMARY KEY (pr_id, fingerprint)
);

-- D-12: Persistent job queue with FSM status.
-- status CHECK keeps invalid states out at the DB layer.
-- attempts tracks retry count for future backoff logic (plan 03).
CREATE TABLE IF NOT EXISTS job_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_id TEXT NOT NULL,              -- owner/repo#number (coalescing key)
  payload TEXT NOT NULL,            -- JSON-encoded JobPayload
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'done', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT
);

-- Indexes to speed up the common queries.
CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status);
CREATE INDEX IF NOT EXISTS idx_job_queue_pr_id ON job_queue(pr_id, status);
CREATE INDEX IF NOT EXISTS idx_posted_comments_pr ON posted_comments(pr_id);

-- D2-01: settings KV table (non-secret config, plaintext values).
-- Each row is a named config key readable by SqliteConfigStore live getters.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- D2-01, D2-05: secrets table (AES-256-GCM encrypted at rest).
-- Format of `encrypted` column: ivHex:tagHex:ciphertextB64 (see src/config/crypto.ts).
-- updated_at is ISO-8601 UTC for audit visibility.
CREATE TABLE IF NOT EXISTS secrets (
  name       TEXT PRIMARY KEY,
  encrypted  TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- D2-07: sessions table (managed by SqliteSessionStore in src/state/sessions.ts).
-- expires_at index enables fast prune of stale sessions.
-- SqliteSessionStore also creates this table with IF NOT EXISTS in its constructor
-- so the store is self-sufficient even when called with a DB opened without schema.sql.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
