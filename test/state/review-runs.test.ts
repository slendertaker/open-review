/**
 * review_runs table: insert, update, page query, getById, TTL prune.
 * Requirements: DACT-01, DACT-02, DACT-03
 *
 * Tests initReviewRuns, insertRunning, updateTerminal, getReviewRunPage,
 * getReviewRunById, and pruneOldReviewRuns
 * from src/state/review-runs.ts using in-memory SQLite.
 *
 * All imports use .js extension per NodeNext ESM resolution.
 *
 * NOTE: This is a Wave 0 RED test scaffold. The production module
 * src/state/review-runs.ts does not yet exist (created in Plan 02).
 * These tests are expected to FAIL until Plan 02 ships.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initReviewRuns,
  insertRunning,
  updateTerminal,
  getReviewRunPage,
  getReviewRunById,
  pruneOldReviewRuns,
} from '../../src/state/review-runs.js';

/** Minimal schema for review_runs state tests (mirrors what Plan 02 adds to schema.sql) */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS review_runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id          TEXT    NOT NULL,
    owner          TEXT    NOT NULL,
    repo           TEXT    NOT NULL,
    pr_number      INTEGER NOT NULL,
    head_sha       TEXT    NOT NULL,
    base_sha       TEXT    NOT NULL,
    installation_id INTEGER,
    provider       TEXT    NOT NULL,
    status         TEXT    NOT NULL
      CHECK (status IN ('running', 'success', 'failed', 'rate_limited')),
    mode           TEXT    NOT NULL DEFAULT 'full'
      CHECK (mode IN ('full', 'incremental')),
    finding_count  INTEGER NOT NULL DEFAULT 0,
    findings_json  TEXT    NOT NULL DEFAULT '[]',
    summary        TEXT    NOT NULL DEFAULT '',
    error          TEXT,
    log            TEXT    NOT NULL DEFAULT '',
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    started_at     TEXT,
    finished_at    TEXT,
    duration_ms    INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_review_runs_created ON review_runs(id DESC);
  CREATE INDEX IF NOT EXISTS idx_review_runs_pr ON review_runs(pr_id, id DESC);
`;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  return db;
}

/** Minimal insert shape used in tests */
interface ReviewRunInsert {
  pr_id: string;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  base_sha: string;
  installation_id?: number | null;
  provider: string;
  mode: 'full' | 'incremental';
}

function makeInsert(overrides: Partial<ReviewRunInsert> = {}): ReviewRunInsert {
  return {
    pr_id: 'owner/repo#1',
    owner: 'owner',
    repo: 'repo',
    pr_number: 1,
    head_sha: 'abc123def456',
    base_sha: 'base123def456',
    installation_id: 42,
    provider: 'claude',
    mode: 'full',
    ...overrides,
  };
}

describe('state/review-runs (DACT-01, DACT-02, DACT-03)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    initReviewRuns(db);
  });

  // DACT-01: insertRunning creates a row and returns a valid id
  it('insertRunning returns a positive integer row id and creates a status=running row', () => {
    const id = insertRunning(makeInsert());

    expect(id).toBeTypeOf('number');
    expect(id).toBeGreaterThan(0);

    const row = getReviewRunById(id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('running');
    expect(row!.pr_id).toBe('owner/repo#1');
    expect(row!.owner).toBe('owner');
    expect(row!.repo).toBe('repo');
    expect(row!.pr_number).toBe(1);
    expect(row!.provider).toBe('claude');
    expect(row!.mode).toBe('full');
  });

  // DACT-01: feed ordering
  it('getReviewRunPage returns rows most-recent-first', () => {
    const id1 = insertRunning(makeInsert({ pr_id: 'owner/repo#1', pr_number: 1 }));
    const id2 = insertRunning(makeInsert({ pr_id: 'owner/repo#2', pr_number: 2 }));
    const id3 = insertRunning(makeInsert({ pr_id: 'owner/repo#3', pr_number: 3 }));

    const page = getReviewRunPage(50, 0);
    expect(page).toHaveLength(3);
    // Most recent first (highest id first)
    expect(page[0]!.id).toBe(id3);
    expect(page[1]!.id).toBe(id2);
    expect(page[2]!.id).toBe(id1);
  });

  // DACT-01: pagination
  it('getReviewRunPage honors LIMIT and OFFSET', () => {
    for (let i = 1; i <= 5; i++) {
      insertRunning(makeInsert({ pr_id: `owner/repo#${i}`, pr_number: i }));
    }

    const page1 = getReviewRunPage(2, 0);
    expect(page1).toHaveLength(2);
    // page1 contains the 2 newest (id 5 and 4)
    expect(page1[0]!.pr_number).toBe(5);
    expect(page1[1]!.pr_number).toBe(4);

    const page2 = getReviewRunPage(2, 2);
    expect(page2).toHaveLength(2);
    // page2 contains the next 2 (id 3 and 2)
    expect(page2[0]!.pr_number).toBe(3);
    expect(page2[1]!.pr_number).toBe(2);
  });

  // DACT-02: updateTerminal sets status, findings, summary, mode, and duration_ms
  it('updateTerminal on a running row sets status, findings, summary, duration_ms', () => {
    const id = insertRunning(makeInsert({ mode: 'full' }));

    const findings = [
      { file: 'a.ts', line: 1, severity: 'high', message: 'missing null check' },
      { file: 'b.ts', line: 20, severity: 'medium', message: 'unused import' },
    ];

    updateTerminal(id, {
      status: 'success',
      finding_count: 2,
      findings_json: JSON.stringify(findings),
      summary: 'Found 2 issues.',
      error: null,
      log: 'log text output',
      mode: 'incremental',
    });

    const row = getReviewRunById(id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('success');
    expect(row!.finding_count).toBe(2);
    expect(row!.summary).toBe('Found 2 issues.');
    expect(row!.mode).toBe('incremental');
    // Guard against Pitfall 3: started_at must be set at insert so duration_ms is computable
    expect(row!.duration_ms).toBeTypeOf('number');
    expect(row!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  // DACT-02: findings_json round-trip
  it('getReviewRunById returns the row whose findings_json round-trips to the original array', () => {
    const id = insertRunning(makeInsert());

    const findings = [
      { file: 'src/api.ts', line: 42, severity: 'high', message: 'SQL injection risk' },
      { file: 'src/util.ts', line: 7, severity: 'low', message: 'console.log left in' },
    ];

    updateTerminal(id, {
      status: 'success',
      finding_count: findings.length,
      findings_json: JSON.stringify(findings),
      summary: 'Review complete.',
      error: null,
      log: '',
      mode: 'full',
    });

    const row = getReviewRunById(id);
    expect(row).not.toBeNull();
    const parsed = JSON.parse(row!.findings_json) as typeof findings;
    expect(parsed).toEqual(findings);
  });

  // DACT-02: getById returns null for unknown id
  it('getReviewRunById returns null for an unknown id', () => {
    const result = getReviewRunById(99999);
    expect(result).toBeNull();
  });

  // DACT-03: TTL prune
  it('pruneOldReviewRuns removes rows older than 90 days but keeps recent rows', () => {
    const oldId = insertRunning(makeInsert({ pr_id: 'owner/repo#10', pr_number: 10 }));
    const recentId = insertRunning(makeInsert({ pr_id: 'owner/repo#11', pr_number: 11 }));

    // Back-date the old row to 91 days ago
    db.prepare(
      "UPDATE review_runs SET created_at = datetime('now', '-91 days') WHERE id = ?"
    ).run(oldId);

    pruneOldReviewRuns();

    expect(getReviewRunById(oldId)).toBeNull();
    expect(getReviewRunById(recentId)).not.toBeNull();
  });

  // DACT-02: failed status stores error and empty findings
  it('updateTerminal with status=failed stores the error and empty findings', () => {
    const id = insertRunning(makeInsert());

    updateTerminal(id, {
      status: 'failed',
      finding_count: 0,
      findings_json: '[]',
      summary: '',
      error: 'Provider returned non-zero exit code',
      log: 'stderr: something went wrong',
      mode: 'full',
    });

    const row = getReviewRunById(id);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('failed');
    expect(row!.finding_count).toBe(0);
    expect(row!.findings_json).toBe('[]');
    expect(row!.error).toBe('Provider returned non-zero exit code');
  });
});
