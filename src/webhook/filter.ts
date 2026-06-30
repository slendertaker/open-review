/**
 * Webhook event filter (INTK-02, INTK-03).
 *
 * Determines whether a webhook event should trigger a review.
 * Filters: event type, action, repo allowlist, draft, fork.
 * Each rejection includes a descriptive reason string.
 *
 * The config accepted here is a minimal FilterConfig subset so the filter
 * does not depend on the full ConfigStore (enables simple unit testing).
 */

export interface FilterConfig {
  repos: string[];
  skipDrafts: boolean;
  skipForks: boolean;
  appConnected: boolean; // true when github_app_slug setting is present (D5-07)
}

export interface FilterResult {
  process: boolean;
  reason: string;
}

/**
 * Actions that trigger a review (INTK-02: opened/synchronize/reopened).
 * reopened was missing from the reference filter.ts -- added per CONTEXT D-02.
 */
const ACTIONABLE_ACTIONS = new Set(['opened', 'synchronize', 'reopened']);

/** Minimal shape of a pull_request webhook payload. */
interface PullRequestPayload {
  action: string;
  repository: {
    full_name: string;
  };
  pull_request: {
    draft?: boolean;
    head: {
      repo?: { full_name?: string } | null;
    };
    base: {
      repo?: { full_name?: string } | null;
    };
  };
}

/**
 * Determine whether a webhook event should trigger a review.
 *
 * @param event   - GitHub event name (e.g. 'pull_request')
 * @param payload - Parsed webhook payload (typed as unknown for safety; validated here)
 * @param config  - Filter configuration
 */
export function shouldProcess(
  event: string,
  payload: unknown,
  config: FilterConfig,
): FilterResult {
  // Step 1: Event type guard.
  if (event !== 'pull_request') {
    return { process: false, reason: `event '${event}' is not pull_request` };
  }

  const p = payload as PullRequestPayload;

  // Step 2: Action filter (INTK-02).
  if (!ACTIONABLE_ACTIONS.has(p.action)) {
    return { process: false, reason: `action '${p.action}' is not actionable` };
  }

  // Step 3: Repo allowlist (INTK-03, D5-07).
  // When appConnected=true (App mode): repos list is authoritative; empty = review nothing (strict opt-in).
  // When appConnected=false (manual/env mode): empty = allow all (legacy, must never regress).
  const repoFullName = p.repository?.full_name;
  if (config.appConnected) {
    // App mode: strict opt-in -- repos list is authoritative; empty = review nothing
    if (!repoFullName || !config.repos.includes(repoFullName)) {
      return { process: false, reason: `repo '${repoFullName ?? ''}' is not in the App allowlist (opt-in required)` };
    }
  } else {
    // Manual/env mode: current behavior -- empty = allow all (never regress this)
    if (config.repos.length > 0 && (!repoFullName || !config.repos.includes(repoFullName))) {
      return { process: false, reason: `repo '${repoFullName ?? ''}' is not in the allowlist` };
    }
  }

  // Step 4: Draft skip (INTK-03, togglable).
  if (config.skipDrafts && p.pull_request?.draft) {
    return { process: false, reason: 'draft PR skipped (skipDrafts=true)' };
  }

  // Step 5: Fork skip (INTK-03, togglable).
  const headRepo = p.pull_request?.head?.repo?.full_name;
  const baseRepo = p.pull_request?.base?.repo?.full_name;
  if (config.skipForks && headRepo !== baseRepo) {
    return { process: false, reason: `fork PR skipped (head=${headRepo ?? 'null'})` };
  }

  return { process: true, reason: 'accepted' };
}
