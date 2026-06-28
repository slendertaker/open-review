/**
 * PR review state: fingerprint dedup, last-reviewed SHA anchor, and 90-day TTL prune.
 * Requirements: NOISE-02, NOISE-03
 *
 * Tests initReviews, recordPostedFingerprints, getPostedFingerprints,
 * setLastReviewedSha, getLastReviewedSha, and pruneOldReviews
 * from src/state/reviews.ts using in-memory SQLite.
 *
 * All imports use .js extension per NodeNext ESM resolution.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initReviews,
  getPostedFingerprints,
  recordPostedFingerprints,
  getLastReviewedSha,
  setLastReviewedSha,
  pruneOldReviews,
} from '../../src/state/reviews.js';

/** Minimal schema for state tests */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS pr_reviews (
    pr_id TEXT PRIMARY KEY,
    last_reviewed_sha TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS posted_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(pr_id, fingerprint)
  );

  CREATE INDEX IF NOT EXISTS idx_posted_comments_pr ON posted_comments(pr_id);
`;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  return db;
}

describe('state/reviews (NOISE-02)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    initReviews(db);
  });

  // NOISE-02: fingerprint dedup
  describe('finding fingerprint dedup (NOISE-02)', () => {
    it('recordPostedFingerprints persists fingerprints to the database', () => {
      const prId = 'owner/repo#42';
      recordPostedFingerprints(prId, ['fp-aaa', 'fp-bbb']);

      const fps = getPostedFingerprints(prId);
      expect(fps.has('fp-aaa')).toBe(true);
      expect(fps.has('fp-bbb')).toBe(true);
    });

    it('getPostedFingerprints returns an empty Set for an unknown PR', () => {
      const fps = getPostedFingerprints('owner/unknown#99');
      expect(fps.size).toBe(0);
    });

    it('a finding fingerprint already in posted_comments is detected as seen', () => {
      const prId = 'owner/repo#7';
      recordPostedFingerprints(prId, ['fp-seen']);

      const fps = getPostedFingerprints(prId);
      expect(fps.has('fp-seen')).toBe(true);
    });

    it('a fingerprint from a different PR is not visible in the current PR query', () => {
      recordPostedFingerprints('pr-A', ['fp-from-a']);
      const fps = getPostedFingerprints('pr-B');
      expect(fps.has('fp-from-a')).toBe(false);
    });

    it('recordPostedFingerprints is idempotent (INSERT OR IGNORE)', () => {
      const prId = 'owner/repo#10';
      // Insert twice — should not throw
      expect(() => {
        recordPostedFingerprints(prId, ['fp-dup']);
        recordPostedFingerprints(prId, ['fp-dup']);
      }).not.toThrow();

      const fps = getPostedFingerprints(prId);
      expect(fps.size).toBe(1);
    });

    it('records multiple fingerprints in a single call', () => {
      const prId = 'owner/repo#11';
      const allFps = ['fp-1', 'fp-2', 'fp-3'];
      recordPostedFingerprints(prId, allFps);

      const fps = getPostedFingerprints(prId);
      expect(fps.size).toBe(3);
      for (const fp of allFps) {
        expect(fps.has(fp)).toBe(true);
      }
    });
  });

  // Last-reviewed SHA (NOISE-03 anchor, also needed for QUEU/ENGN integration)
  describe('last-reviewed SHA anchor', () => {
    it('getLastReviewedSha returns null for a PR that has never been reviewed', () => {
      expect(getLastReviewedSha('owner/repo#99')).toBeNull();
    });

    it('setLastReviewedSha persists and getLastReviewedSha returns it', () => {
      const prId = 'owner/repo#5';
      setLastReviewedSha(prId, 'deadbeef');
      expect(getLastReviewedSha(prId)).toBe('deadbeef');
    });

    it('setLastReviewedSha updates the SHA on a subsequent call (upsert behavior)', () => {
      const prId = 'owner/repo#6';
      setLastReviewedSha(prId, 'old-sha');
      setLastReviewedSha(prId, 'new-sha');
      expect(getLastReviewedSha(prId)).toBe('new-sha');
    });
  });

  // 90-day TTL prune (NOISE-02 / NOISE-03 table maintenance)
  describe('pruneOldReviews -- 90-day TTL (NOISE-02, NOISE-03)', () => {
    it('pruneOldReviews removes pr_reviews rows older than 90 days', () => {
      const prId = 'owner/repo#stale';
      setLastReviewedSha(prId, 'abc123');

      // Back-date the row to 91 days ago.
      db.prepare(
        "UPDATE pr_reviews SET updated_at = datetime('now', '-91 days') WHERE pr_id = ?"
      ).run(prId);

      pruneOldReviews();
      expect(getLastReviewedSha(prId)).toBeNull();
    });

    it('pruneOldReviews keeps pr_reviews rows within 90 days', () => {
      const prId = 'owner/repo#fresh';
      setLastReviewedSha(prId, 'def456');

      // Row was updated 10 days ago -- should survive the prune.
      db.prepare(
        "UPDATE pr_reviews SET updated_at = datetime('now', '-10 days') WHERE pr_id = ?"
      ).run(prId);

      pruneOldReviews();
      expect(getLastReviewedSha(prId)).toBe('def456');
    });

    it('pruneOldReviews removes posted_comments rows older than 90 days', () => {
      const prId = 'owner/repo#oldcomments';
      recordPostedFingerprints(prId, ['fp-old']);

      // Back-date the fingerprint to 91 days ago.
      db.prepare(
        "UPDATE posted_comments SET created_at = datetime('now', '-91 days') WHERE pr_id = ?"
      ).run(prId);

      pruneOldReviews();
      const fps = getPostedFingerprints(prId);
      expect(fps.has('fp-old')).toBe(false);
    });

    it('pruneOldReviews keeps posted_comments rows within 90 days', () => {
      const prId = 'owner/repo#recentcomments';
      recordPostedFingerprints(prId, ['fp-recent']);

      // Row within the 90-day window.
      db.prepare(
        "UPDATE posted_comments SET created_at = datetime('now', '-10 days') WHERE pr_id = ?"
      ).run(prId);

      pruneOldReviews();
      const fps = getPostedFingerprints(prId);
      expect(fps.has('fp-recent')).toBe(true);
    });

    it('pruneOldReviews does not throw on empty tables', () => {
      expect(() => pruneOldReviews()).not.toThrow();
    });
  });

  // Cross-push dedup integration: simulate two pushes (NOISE-02)
  describe('cross-push fingerprint dedup integration (NOISE-02)', () => {
    it('a finding posted on push-1 is detected as duplicate on push-2', () => {
      const prId = 'owner/repo#100';

      // Push 1: post a finding, record its fingerprint.
      const fp = 'sha1-of-finding-abc';
      recordPostedFingerprints(prId, [fp]);
      setLastReviewedSha(prId, 'sha-push-1');

      // Push 2: check posted fingerprints to detect duplicate.
      const seen = getPostedFingerprints(prId);
      expect(seen.has(fp)).toBe(true);
    });

    it('a new finding on push-2 that was not in push-1 is not a duplicate', () => {
      const prId = 'owner/repo#101';
      recordPostedFingerprints(prId, ['fp-push-1']);
      setLastReviewedSha(prId, 'sha-push-1');

      // Push 2: new finding with different fingerprint.
      const seen = getPostedFingerprints(prId);
      expect(seen.has('fp-push-2-new')).toBe(false);
    });
  });
});
