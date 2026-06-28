/**
 * Persistent SQLite job queue FSM tests
 * Requirements: QUEU-01, QUEU-02, QUEU-03, QUEU-04, QUEU-05
 *
 * Tests the createQueue factory from src/queue/queue.ts using in-memory SQLite.
 * The queue API is expected to be:
 *   createQueue(db) -> { enqueue, claimNext, complete, fail, reclaimRunning, setRunner, startDrainLoop, stop }
 *
 * All imports use .js extension per NodeNext ESM resolution.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createQueue } from '../../src/queue/queue.js';
import { RateLimitError } from '../../src/queue/types.js';

/** Minimal SQLite schema for the job_queue table */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS job_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pr_id TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    attempts INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status);
  CREATE INDEX IF NOT EXISTS idx_job_queue_pr_id ON job_queue(pr_id, status);
`;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  return db;
}

describe('createQueue (QUEU-01, QUEU-02, QUEU-03)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  // QUEU-01: job persists in SQLite and survives a simulated restart
  describe('job persistence (QUEU-01)', () => {
    it('enqueue persists a pending row in the database', () => {
      const queue = createQueue(db);
      queue.enqueue('pr-123', JSON.stringify({ owner: 'a', repo: 'b', prNumber: 1, sha: 'abc' }));

      // Read directly from the DB to verify persistence (simulates reading after restart)
      const rows = db.prepare("SELECT * FROM job_queue WHERE pr_id = 'pr-123'").all() as Array<{
        pr_id: string;
        status: string;
        payload: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.pr_id).toBe('pr-123');
      expect(rows[0]!.status).toBe('pending');
    });

    it('persisted pending job is visible when re-reading the DB (simulated restart)', () => {
      const queue = createQueue(db);
      const payload = JSON.stringify({ owner: 'x', repo: 'y', prNumber: 5, sha: 'deadbeef' });
      queue.enqueue('pr-456', payload);

      // Simulate "restart" by creating a new queue on the same db handle
      const queue2 = createQueue(db);
      const job = queue2.claimNext();
      expect(job).not.toBeNull();
      expect(job!.pr_id).toBe('pr-456');
      expect(job!.payload).toBe(payload);
    });
  });

  // QUEU-02: running rows reclaimed to pending on startup crash recovery
  describe('crash recovery (QUEU-02)', () => {
    it('reclaimRunning flips running rows back to pending', () => {
      const queue = createQueue(db);
      queue.enqueue('pr-crash', JSON.stringify({ sha: 'deadcafe' }));

      // Claim the job (making it running)
      const job = queue.claimNext();
      expect(job).not.toBeNull();

      // Verify it is now running
      const runningRows = db.prepare("SELECT status FROM job_queue WHERE pr_id = 'pr-crash'").all() as Array<{ status: string }>;
      expect(runningRows[0]!.status).toBe('running');

      // Simulate restart: call reclaimRunning
      queue.reclaimRunning();

      // Verify it is now pending again
      const pendingRows = db.prepare("SELECT status FROM job_queue WHERE pr_id = 'pr-crash'").all() as Array<{ status: string }>;
      expect(pendingRows[0]!.status).toBe('pending');
    });

    it('reclaimRunning does not affect already-pending rows', () => {
      const queue = createQueue(db);
      queue.enqueue('pr-pending', JSON.stringify({ sha: 'aabbcc' }));

      queue.reclaimRunning();

      const rows = db.prepare("SELECT status FROM job_queue WHERE pr_id = 'pr-pending'").all() as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('pending');
    });

    it('reclaimRunning does not affect done or failed rows', () => {
      const queue = createQueue(db);
      queue.enqueue('pr-done', JSON.stringify({ sha: '111111' }));
      const job = queue.claimNext();
      queue.complete(job!.id);

      queue.reclaimRunning();

      const rows = db.prepare("SELECT status FROM job_queue WHERE pr_id = 'pr-done'").all() as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('done');
    });
  });

  // QUEU-03: latest-wins coalescing for same PR
  describe('latest-wins coalescing (QUEU-03)', () => {
    it('second enqueue for the same PR while pending updates payload in place (single row)', () => {
      const queue = createQueue(db);
      const payload1 = JSON.stringify({ sha: 'sha-old' });
      const payload2 = JSON.stringify({ sha: 'sha-new' });

      queue.enqueue('pr-coalesce', payload1);
      queue.enqueue('pr-coalesce', payload2);

      const rows = db.prepare("SELECT * FROM job_queue WHERE pr_id = 'pr-coalesce'").all() as Array<{
        payload: string;
        status: string;
      }>;

      // Must be exactly one row (no duplicate insertion)
      expect(rows).toHaveLength(1);
      // Payload must be the latest (sha-new)
      expect(JSON.parse(rows[0]!.payload)).toEqual({ sha: 'sha-new' });
      // Status must remain pending
      expect(rows[0]!.status).toBe('pending');
    });

    it('third enqueue for same PR while pending also updates in place', () => {
      const queue = createQueue(db);
      queue.enqueue('pr-multi', JSON.stringify({ sha: 'v1' }));
      queue.enqueue('pr-multi', JSON.stringify({ sha: 'v2' }));
      queue.enqueue('pr-multi', JSON.stringify({ sha: 'v3' }));

      const rows = db.prepare("SELECT * FROM job_queue WHERE pr_id = 'pr-multi'").all() as Array<{
        payload: string;
      }>;
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0]!.payload)).toEqual({ sha: 'v3' });
    });

    it('enqueue for a PR whose prior job is already running creates a new pending row', () => {
      const queue = createQueue(db);
      queue.enqueue('pr-running', JSON.stringify({ sha: 'r1' }));
      queue.claimNext(); // transitions to running

      // Now enqueue a new job while prior is running
      queue.enqueue('pr-running', JSON.stringify({ sha: 'r2' }));

      const rows = db.prepare("SELECT status, payload FROM job_queue WHERE pr_id = 'pr-running' ORDER BY id").all() as Array<{
        status: string;
        payload: string;
      }>;
      // Should have a running row and a new pending row
      expect(rows.some((r) => r.status === 'running')).toBe(true);
      expect(rows.some((r) => r.status === 'pending')).toBe(true);
    });
  });

  // FSM complete/fail transitions
  describe('FSM transitions (complete / fail)', () => {
    it('complete marks a running job as done', () => {
      const queue = createQueue(db);
      queue.enqueue('pr-comp', JSON.stringify({ sha: 'abc' }));
      const job = queue.claimNext();
      queue.complete(job!.id);

      const rows = db.prepare("SELECT status FROM job_queue WHERE id = ?").all(job!.id) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('done');
    });

    it('fail marks a running job as failed', () => {
      const queue = createQueue(db);
      queue.enqueue('pr-fail', JSON.stringify({ sha: 'abc' }));
      const job = queue.claimNext();
      queue.fail(job!.id);

      const rows = db.prepare("SELECT status FROM job_queue WHERE id = ?").all(job!.id) as Array<{ status: string }>;
      expect(rows[0]!.status).toBe('failed');
    });

    it('claimNext returns null when no pending jobs exist', () => {
      const queue = createQueue(db);
      expect(queue.claimNext()).toBeNull();
    });
  });

  // QUEU-04: concurrency cap -- drain loop runs at most one job at a time
  describe('concurrency cap (QUEU-04)', () => {
    it('drain loop runs jobs sequentially (not concurrently)', async () => {
      const queue = createQueue(db);
      const runOrder: string[] = [];

      // Use a latch so we can control when runner resolves
      let releaseLatch: (() => void) | undefined;

      queue.setRunner(async (job) => {
        runOrder.push(`start:${job.pr_id}`);
        await new Promise<void>((res) => { releaseLatch = res; });
        runOrder.push(`end:${job.pr_id}`);
      });

      queue.enqueue('pr-cap-A', JSON.stringify({ sha: 'ca' }));
      queue.enqueue('pr-cap-B', JSON.stringify({ sha: 'cb' }));

      queue.startDrainLoop(10);

      // Wait for first job to start
      await new Promise<void>((res) => setTimeout(res, 30));

      // At this point only the first job should have started (not the second)
      expect(runOrder).toContain('start:pr-cap-A');
      expect(runOrder).not.toContain('start:pr-cap-B');

      // Release the latch so job A completes
      releaseLatch?.();

      // Wait for job B to start and complete
      await new Promise<void>((res) => setTimeout(res, 50));
      releaseLatch?.();

      await new Promise<void>((res) => setTimeout(res, 30));

      queue.stop();

      // Jobs ran in order, not concurrently
      const startA = runOrder.indexOf('start:pr-cap-A');
      const endA = runOrder.indexOf('end:pr-cap-A');
      const startB = runOrder.indexOf('start:pr-cap-B');
      if (startB !== -1) {
        expect(startA).toBeLessThan(endA);
        expect(endA).toBeLessThan(startB);
      }
    });
  });

  // QUEU-05: rate-limit backoff -- RateLimitError re-enqueues, does not fail
  describe('rate-limit backoff (QUEU-05)', () => {
    it('RateLimitError from runner causes job to be re-enqueued (not marked failed)', async () => {
      const queue = createQueue(db);

      let runCount = 0;
      // Runner throws RateLimitError on first call
      queue.setRunner(async (_job) => {
        runCount++;
        throw new RateLimitError(50); // 50 ms backoff
      });

      queue.enqueue('pr-rl', JSON.stringify({ sha: 'rl1' }));
      queue.startDrainLoop(20);

      // Wait for the first drain tick to run and fail with RateLimitError
      await new Promise<void>((res) => setTimeout(res, 60));

      queue.stop();

      // Runner was called at least once
      expect(runCount).toBeGreaterThanOrEqual(1);

      // Job must NOT be 'failed' -- it should be pending (re-enqueued) or running (picked up again)
      const rows = db
        .prepare("SELECT status FROM job_queue WHERE pr_id = 'pr-rl'")
        .all() as Array<{ status: string }>;
      const statuses = rows.map((r) => r.status);
      expect(statuses.every((s) => s !== 'failed')).toBe(true);
    });

    it('job re-enqueued after RateLimitError is eventually retried and completed', async () => {
      const queue = createQueue(db);

      let runCount = 0;

      queue.setRunner(async (_job) => {
        runCount++;
        if (runCount === 1) {
          throw new RateLimitError(30); // 30 ms backoff
        }
        // Second run succeeds (no throw)
      });

      queue.enqueue('pr-retry', JSON.stringify({ sha: 'r1' }));
      queue.startDrainLoop(20);

      // Wait long enough for the retry to happen (30ms backoff + drain interval)
      await new Promise<void>((res) => setTimeout(res, 200));

      queue.stop();

      // Runner should have been called at least twice (initial + retry)
      expect(runCount).toBeGreaterThanOrEqual(2);

      // After successful retry, job should be done
      const rows = db
        .prepare("SELECT status FROM job_queue WHERE pr_id = 'pr-retry'")
        .all() as Array<{ status: string }>;
      const statuses = rows.map((r) => r.status);
      expect(statuses.some((s) => s === 'done')).toBe(true);
    });
  });
});
