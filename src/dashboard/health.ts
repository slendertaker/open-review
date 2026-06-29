/**
 * Health aggregation for the dashboard (DACT-03, D3-06, D3-07).
 *
 * computeHealthData(db, store): async HealthData
 *   Reads job_queue status counts, the newest review_runs row, and provider
 *   credential presence. The Claude CLI version probe is cached for 5 minutes
 *   so the 5-second poll never spawns the subprocess on every call.
 *
 * getCliProbe(probeFn?): async { version, error }
 *   Returns cached result when fresh (within CLI_PROBE_TTL_MS). Otherwise runs
 *   the injected probe function (or the default assertClaudeVersion wrapper)
 *   and caches the result. Never throws -- probe errors are captured into error.
 *
 * resetCliProbeCache(): exported for tests to clear module-level cache between cases.
 */

import type Database from 'better-sqlite3';
import type { ConfigStore } from '../config/store.js';
import { getSecretRecord } from '../state/config-state.js';
import { getReviewRunPage, type ReviewRunRow } from '../state/review-runs.js';
import { assertClaudeVersion } from '../startup.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HealthData {
  pending: number;
  running: number;
  lastRun: ReviewRunRow | null;
  provider: string;
  hasOauthToken: boolean;
  hasApiKey: boolean;
  cliVersion: string | null;
  cliError: string | null;
}

// ---------------------------------------------------------------------------
// CLI probe cache (module-level, 5-minute TTL)
// ---------------------------------------------------------------------------

export const CLI_PROBE_TTL_MS = 5 * 60 * 1000;

interface ProbeCache {
  version: string | null;
  error: string | null;
  checkedAt: number;
}

let cliProbeCache: ProbeCache | null = null;

/** Clear the module-level CLI probe cache. Used in tests to reset between cases. */
export function resetCliProbeCache(): void {
  cliProbeCache = null;
}

/**
 * Return the cached CLI probe result if it is still within the TTL window.
 * Otherwise run the probe function, cache the result, and return it.
 *
 * @param probeFn - Optional injected probe function. Defaults to a thin wrapper
 *   around assertClaudeVersion that resolves to a version string on success.
 *   For testability, accepts a function that returns { version, error }.
 */
export async function getCliProbe(
  probeFn?: () => Promise<{ version: string | null; error: string | null }>,
): Promise<{ version: string | null; error: string | null }> {
  const now = Date.now();

  // Return cache if still fresh.
  if (cliProbeCache !== null && now - cliProbeCache.checkedAt < CLI_PROBE_TTL_MS) {
    return { version: cliProbeCache.version, error: cliProbeCache.error };
  }

  let version: string | null = null;
  let error: string | null = null;

  if (probeFn) {
    // Use injected probe (for tests).
    try {
      const result = await probeFn();
      version = result.version;
      error = result.error;
    } catch (err: unknown) {
      error = String(err);
    }
  } else {
    // Default: run assertClaudeVersion and capture result.
    try {
      await assertClaudeVersion();
      // assertClaudeVersion does not return the version string; indicate success.
      version = 'ok';
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
    }
  }

  cliProbeCache = { version, error, checkedAt: now };
  return { version, error };
}

// ---------------------------------------------------------------------------
// Health aggregation
// ---------------------------------------------------------------------------

/**
 * Compute a snapshot of service health from existing state.
 *
 * Queue depth: synchronous COUNT queries against job_queue.
 * Last run: getReviewRunPage(1, 0)[0] ?? null.
 * Provider: store.provider + getSecretRecord credential presence.
 * CLI probe: awaited via getCliProbe() which short-circuits to cache.
 */
export async function computeHealthData(
  db: Database.Database,
  store: ConfigStore,
): Promise<HealthData> {
  // Queue depth counts.
  const pendingRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM job_queue WHERE status = 'pending'`)
    .get() as { cnt: number };
  const runningRow = db
    .prepare(`SELECT COUNT(*) AS cnt FROM job_queue WHERE status = 'running'`)
    .get() as { cnt: number };

  const pending = pendingRow.cnt;
  const running = runningRow.cnt;

  // Last review run (newest row).
  const lastRun = getReviewRunPage(1, 0)[0] ?? null;

  // Provider and credential presence.
  const provider = store.provider;
  const hasOauthToken = !!getSecretRecord('claude_oauth_token');
  const hasApiKey = !!getSecretRecord('anthropic_api_key');

  // CLI probe (cached, no per-poll spawn).
  const { version: cliVersion, error: cliError } = await getCliProbe();

  return {
    pending,
    running,
    lastRun,
    provider,
    hasOauthToken,
    hasApiKey,
    cliVersion,
    cliError,
  };
}
