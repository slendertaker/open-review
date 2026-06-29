/**
 * Queue types shared between the queue implementation and the pipeline (D-12).
 */

/** Payload describing the PR to review. */
export interface JobPayload {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  /** GitHub App installation ID (App mode). Optional in PAT mode. */
  installationId?: number;
}

/** Result returned by a completed review job. */
export interface JobResult {
  findings: Array<{
    file: string;
    line: number;
    severity: string;
    message: string;
  }>;
  summary: string;
  mode: 'full' | 'incremental';
  rawLog: string;
}

/**
 * Thrown by the runner when Claude exits with code 29 (rate-limited).
 * The queue uses this to schedule a backoff retry (plan 03).
 */
export class RateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number = 60_000) {
    super(`Rate limited -- retry after ${retryAfterMs}ms`);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** A claimed job row returned by claimNext(). */
export interface ClaimedJob {
  id: number;
  pr_id: string;
  payload: string;
  attempts: number;
}
