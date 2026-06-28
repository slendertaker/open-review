/**
 * pr_reviews + posted_comments tables: fingerprint dedup and last-reviewed SHA (D-13, INCR-01/02).
 *
 * initReviews must be called once (by openDb) before any other function.
 * All functions are synchronous (better-sqlite3 is synchronous).
 */

import type Database from 'better-sqlite3';

type Statement = Database.Statement<unknown[]>;

let getLastSha: Statement | null = null;
let setLastSha: Statement | null = null;
let insertFingerprint: Statement | null = null;
let getFingerprints: Statement | null = null;

/**
 * Prepare module-level statements against the provided database handle.
 * Must be called once (by openDb) before any other function in this module.
 */
export function initReviews(db: Database.Database): void {
  getLastSha = db.prepare('SELECT last_reviewed_sha FROM pr_reviews WHERE pr_id = ?');
  setLastSha = db.prepare(
    `INSERT INTO pr_reviews (pr_id, last_reviewed_sha, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(pr_id) DO UPDATE SET last_reviewed_sha = excluded.last_reviewed_sha,
                                       updated_at = excluded.updated_at`,
  );
  insertFingerprint = db.prepare(
    'INSERT OR IGNORE INTO posted_comments (pr_id, fingerprint, created_at) VALUES (?, ?, ?)',
  );
  getFingerprints = db.prepare('SELECT fingerprint FROM posted_comments WHERE pr_id = ?');
}

/** Returns the last successfully-reviewed head SHA for a PR, or null if never reviewed. */
export function getLastReviewedSha(prId: string): string | null {
  if (!getLastSha) throw new Error('reviews not initialised -- call openDb() first');
  const row = getLastSha.get(prId) as { last_reviewed_sha: string } | undefined;
  return row?.last_reviewed_sha ?? null;
}

/** Persist (or update) the last-reviewed head SHA for a PR. */
export function setLastReviewedSha(prId: string, sha: string): void {
  if (!setLastSha) throw new Error('reviews not initialised -- call openDb() first');
  setLastSha.run(prId, sha, new Date().toISOString());
}

/** Return all posted finding fingerprints for a PR as a Set. */
export function getPostedFingerprints(prId: string): Set<string> {
  if (!getFingerprints) throw new Error('reviews not initialised -- call openDb() first');
  const rows = getFingerprints.all(prId) as Array<{ fingerprint: string }>;
  return new Set(rows.map((r) => r.fingerprint));
}

/**
 * Persist fingerprints for findings posted on a PR (INSERT OR IGNORE for idempotency).
 * Pass an empty array to no-op.
 */
export function recordPostedFingerprints(prId: string, fingerprints: string[]): void {
  if (!insertFingerprint) throw new Error('reviews not initialised -- call openDb() first');
  const now = new Date().toISOString();
  for (const fp of fingerprints) {
    insertFingerprint.run(prId, fp, now);
  }
}
