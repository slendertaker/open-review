/**
 * Persistent SQLite job queue (D-12, QUEU-01..05).
 *
 * Uses better-sqlite3 (synchronous) for atomic operations.
 * Single-worker poll loop: at most one job runs at a time (concurrency cap = 1, QUEU-04).
 *
 * Design:
 *   enqueue(prId, payload)
 *     - If a pending row for this PR exists, update it in place (latest-wins
 *       coalescing: a fast-push cannot spawn duplicate jobs for the same PR).
 *     - If no pending row exists (first push, or prior job is running/done/failed),
 *       INSERT a new pending row.
 *   claimNext()
 *     - Atomic UPDATE...RETURNING: sets status='running', increments attempts,
 *       records started_at; returns the claimed row or null.
 *   complete(id) / fail(id) -- FSM terminal transitions.
 *   reclaimRunning()
 *     - On startup: flips any 'running' rows back to 'pending' (crash recovery, QUEU-02).
 *   setRunner(fn) + startDrainLoop() -- single-worker execution seam.
 *
 * Rate-limit handling (QUEU-05):
 *   When the runner throws RateLimitError, the job is re-enqueued (back to pending)
 *   after err.retryAfterMs via setTimeout. The job is NOT marked failed or dropped.
 */

import type Database from 'better-sqlite3';
import { RateLimitError } from './types.js';
import type { ClaimedJob } from './types.js';

export type { ClaimedJob };

export interface Queue {
  /** Enqueue a job (latest-wins coalescing for pending rows). */
  enqueue(prId: string, payload: string): void;
  /** Claim the next pending job atomically; returns null if none. */
  claimNext(): ClaimedJob | null;
  /** Transition a running job to done. */
  complete(id: number): void;
  /** Transition a running job to failed. */
  fail(id: number): void;
  /** Flip any running rows back to pending (startup crash recovery). */
  reclaimRunning(): void;
  /** Set the async runner function for the drain loop. */
  setRunner(fn: (job: ClaimedJob) => Promise<void>): void;
  /** Start the drain loop (non-blocking; resolves when the loop exits). */
  startDrainLoop(intervalMs?: number): void;
  /** Stop the drain loop. */
  stop(): void;
}

/**
 * Create a persistent queue backed by the provided better-sqlite3 database.
 * The caller must have already applied the schema (job_queue table must exist).
 */
export function createQueue(db: Database.Database): Queue {
  // Prepared statements -- compiled once, reused per call.
  const stmtInsert = db.prepare(
    `INSERT INTO job_queue (pr_id, payload, status, created_at)
     VALUES (?, ?, 'pending', datetime('now'))`,
  );

  const stmtUpdatePending = db.prepare(
    `UPDATE job_queue SET payload = ?
     WHERE pr_id = ? AND status = 'pending'
     AND id = (SELECT id FROM job_queue WHERE pr_id = ? AND status = 'pending' LIMIT 1)`,
  );

  const stmtCountPending = db.prepare(
    `SELECT COUNT(*) as cnt FROM job_queue WHERE pr_id = ? AND status = 'pending'`,
  );

  // Atomic claim: UPDATE...RETURNING (SQLite >= 3.35).
  const stmtClaim = db.prepare(
    `UPDATE job_queue
     SET status = 'running', started_at = datetime('now'), attempts = attempts + 1
     WHERE id = (
       SELECT id FROM job_queue
       WHERE status = 'pending'
       ORDER BY created_at
       LIMIT 1
     )
     RETURNING id, pr_id, payload, attempts`,
  );

  const stmtComplete = db.prepare(
    `UPDATE job_queue SET status = 'done' WHERE id = ?`,
  );

  const stmtFail = db.prepare(
    `UPDATE job_queue SET status = 'failed' WHERE id = ?`,
  );

  // Flip a specific running row back to pending (used for rate-limit retry, QUEU-05).
  const stmtReclaimOne = db.prepare(
    `UPDATE job_queue SET status = 'pending', started_at = NULL WHERE id = ?`,
  );

  const stmtReclaim = db.prepare(
    `UPDATE job_queue SET status = 'pending', started_at = NULL WHERE status = 'running'`,
  );

  let runner: ((job: ClaimedJob) => Promise<void>) | null = null;
  let drainRunning = false;
  let drainTimer: ReturnType<typeof setTimeout> | undefined;

  function enqueue(prId: string, payload: string): void {
    // Latest-wins coalescing: if there is already a pending row for this PR,
    // update it in place (avoid duplicate jobs for rapid pushes).
    const row = stmtCountPending.get(prId) as { cnt: number };
    if (row.cnt > 0) {
      stmtUpdatePending.run(payload, prId, prId);
    } else {
      stmtInsert.run(prId, payload);
    }
  }

  function claimNext(): ClaimedJob | null {
    const claimed = stmtClaim.get() as ClaimedJob | undefined;
    return claimed ?? null;
  }

  function complete(id: number): void {
    stmtComplete.run(id);
  }

  function fail(id: number): void {
    stmtFail.run(id);
  }

  function reclaimRunning(): void {
    stmtReclaim.run();
  }

  function setRunner(fn: (job: ClaimedJob) => Promise<void>): void {
    runner = fn;
  }

  function startDrainLoop(intervalMs: number = 1000): void {
    if (drainRunning) return;
    drainRunning = true;

    async function tick(): Promise<void> {
      if (!drainRunning) return;
      if (runner) {
        const job = claimNext();
        if (job) {
          try {
            await runner(job);
            complete(job.id);
          } catch (err) {
            if (err instanceof RateLimitError) {
              // QUEU-05: backoff + re-enqueue instead of marking failed.
              // Flip the running row back to pending after retryAfterMs.
              // The row stays 'running' during the wait so reclaimRunning() would
              // pick it up safely on a crash during the backoff window.
              const retryMs = err.retryAfterMs;
              const jobId = job.id;
              setTimeout(() => {
                stmtReclaimOne.run(jobId);
              }, retryMs);
              // Wait for the normal interval before polling again.
              if (drainRunning) {
                drainTimer = setTimeout(() => { void tick(); }, intervalMs);
              }
              return;
            }
            // Non-rate-limit error: mark the job failed.
            fail(job.id);
          }
          // Immediately try the next job without waiting for the interval.
          if (drainRunning) {
            drainTimer = setTimeout(() => { void tick(); }, 0);
            return;
          }
        }
      }
      // No job available -- poll after interval.
      if (drainRunning) {
        drainTimer = setTimeout(() => { void tick(); }, intervalMs);
      }
    }

    drainTimer = setTimeout(() => { void tick(); }, 0);
  }

  function stop(): void {
    drainRunning = false;
    if (drainTimer !== undefined) {
      clearTimeout(drainTimer);
      drainTimer = undefined;
    }
  }

  return { enqueue, claimNext, complete, fail, reclaimRunning, setRunner, startDrainLoop, stop };
}
