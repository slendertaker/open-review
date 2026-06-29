/**
 * review_runs table: durable per-review history (D3-01, D3-02, D3-03).
 *
 * initReviewRuns must be called once (by openDb) before any other function.
 * All functions are synchronous (better-sqlite3 is synchronous).
 */

import type Database from 'better-sqlite3';

type Statement = Database.Statement<unknown[]>;

let stmtInsertRunning: Statement | null = null;
let stmtUpdateTerminal: Statement | null = null;
let stmtGetPage: Statement | null = null;
let stmtGetById: Statement | null = null;
let stmtPrune: Statement | null = null;

/** Shape required to insert a new running row. */
export interface ReviewRunInsert {
  pr_id: string;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  base_sha: string;
  installation_id: number | null;
  provider: string;
  mode: 'full' | 'incremental';
}

/** Shape required to update a running row to a terminal state. */
export interface ReviewRunUpdate {
  status: 'success' | 'failed' | 'rate_limited';
  finding_count: number;
  findings_json: string;
  summary: string;
  error: string | null;
  log: string;
  mode: 'full' | 'incremental';
}

/** Full row shape returned by getReviewRunPage and getReviewRunById. */
export interface ReviewRunRow {
  id: number;
  pr_id: string;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  base_sha: string;
  installation_id: number | null;
  provider: string;
  status: string;
  mode: string;
  finding_count: number;
  findings_json: string;
  summary: string;
  error: string | null;
  log: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
}

/**
 * Prepare module-level statements against the provided database handle.
 * Must be called once (by openDb) before any other function in this module.
 */
export function initReviewRuns(db: Database.Database): void {
  stmtInsertRunning = db.prepare(
    `INSERT INTO review_runs
       (pr_id, owner, repo, pr_number, head_sha, base_sha, installation_id,
        provider, status, mode, created_at, started_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, datetime('now'), datetime('now'))`,
  );

  stmtUpdateTerminal = db.prepare(
    `UPDATE review_runs
     SET status       = ?,
         finding_count = ?,
         findings_json = ?,
         summary      = ?,
         error        = ?,
         log          = ?,
         mode         = ?,
         finished_at  = datetime('now'),
         duration_ms  = CAST((julianday('now') - julianday(started_at)) * 86400000 AS INTEGER)
     WHERE id = ?`,
  );

  stmtGetPage = db.prepare(
    `SELECT * FROM review_runs ORDER BY id DESC LIMIT ? OFFSET ?`,
  );

  stmtGetById = db.prepare(
    `SELECT * FROM review_runs WHERE id = ?`,
  );

  stmtPrune = db.prepare(
    `DELETE FROM review_runs WHERE datetime(created_at) < datetime('now', '-90 days')`,
  );
}

/**
 * Insert a new row with status='running'. Returns the new row's id.
 * started_at is set to datetime('now') so duration_ms is computable on terminal update.
 */
export function insertRunning(row: ReviewRunInsert): number {
  if (!stmtInsertRunning) throw new Error('review-runs not initialised -- call openDb() first');
  const info = stmtInsertRunning.run(
    row.pr_id,
    row.owner,
    row.repo,
    row.pr_number,
    row.head_sha,
    row.base_sha,
    row.installation_id,
    row.provider,
    row.mode,
  );
  return Number(info.lastInsertRowid);
}

/**
 * Update a running row to a terminal state.
 * Sets status, finding_count, findings_json, summary, error, log, mode,
 * finished_at, and computes duration_ms from started_at.
 */
export function updateTerminal(id: number, data: ReviewRunUpdate): void {
  if (!stmtUpdateTerminal) throw new Error('review-runs not initialised -- call openDb() first');
  stmtUpdateTerminal.run(
    data.status,
    data.finding_count,
    data.findings_json,
    data.summary,
    data.error,
    data.log,
    data.mode,
    id,
  );
}

/**
 * Return a page of review run rows, most-recent-first.
 * limit: max rows to return; offset: number of rows to skip.
 */
export function getReviewRunPage(limit: number, offset: number): ReviewRunRow[] {
  if (!stmtGetPage) throw new Error('review-runs not initialised -- call openDb() first');
  return stmtGetPage.all(limit, offset) as ReviewRunRow[];
}

/**
 * Return the full row for the given id, or null if not found.
 */
export function getReviewRunById(id: number): ReviewRunRow | null {
  if (!stmtGetById) throw new Error('review-runs not initialised -- call openDb() first');
  const row = stmtGetById.get(id) as ReviewRunRow | undefined;
  return row ?? null;
}

/**
 * TTL prune of review_runs (D3-03).
 * Deletes rows with created_at older than 90 days.
 * Call at startup and periodically to keep the table bounded.
 */
export function pruneOldReviewRuns(): void {
  if (!stmtPrune) throw new Error('review-runs not initialised -- call openDb() first');
  stmtPrune.run();
}
