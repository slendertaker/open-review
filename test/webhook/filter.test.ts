/**
 * Wave 0 test: PR webhook event filter
 * Requirements: INTK-02, INTK-03
 *
 * Tests the shouldProcess function from src/webhook/filter.ts.
 * All imports use .js extension per NodeNext ESM resolution.
 */

import { describe, it, expect } from 'vitest';
import { shouldProcess } from '../../src/webhook/filter.js';

/** Minimal FilterConfig matching what src/webhook/filter.ts will accept */
interface FilterConfig {
  repos: string[];
  skipDrafts: boolean;
  skipForks: boolean;
  appConnected: boolean; // Phase 5 (D5-07): true when github_app_slug setting is present
}

/** Build a synthetic PullRequestEvent payload for testing */
function makePayload(options: {
  action?: string;
  repoFullName?: string;
  draft?: boolean;
  headRepo?: string;
  baseRepo?: string;
}): Record<string, unknown> {
  const repoFullName = options.repoFullName ?? 'owner/repo';
  const headRepo = options.headRepo ?? repoFullName;
  const baseRepo = options.baseRepo ?? repoFullName;

  return {
    action: options.action ?? 'opened',
    repository: {
      full_name: repoFullName,
    },
    pull_request: {
      draft: options.draft ?? false,
      head: {
        repo: {
          full_name: headRepo,
        },
      },
      base: {
        repo: {
          full_name: baseRepo,
        },
      },
    },
  };
}

const DEFAULT_CONFIG: FilterConfig = {
  repos: [],
  skipDrafts: true,
  skipForks: true,
  appConnected: false, // Phase 5 (D5-07): false = manual/env mode, preserving empty=allow-all
};

describe('shouldProcess (INTK-02, INTK-03)', () => {
  // INTK-02: allowed actions
  describe('action filter (INTK-02)', () => {
    it('accepts "opened" action', () => {
      const result = shouldProcess('pull_request', makePayload({ action: 'opened' }), DEFAULT_CONFIG);
      expect(result.process).toBe(true);
    });

    it('accepts "synchronize" action', () => {
      const result = shouldProcess('pull_request', makePayload({ action: 'synchronize' }), DEFAULT_CONFIG);
      expect(result.process).toBe(true);
    });

    it('accepts "reopened" action', () => {
      const result = shouldProcess('pull_request', makePayload({ action: 'reopened' }), DEFAULT_CONFIG);
      expect(result.process).toBe(true);
    });

    it('blocks "closed" action', () => {
      const result = shouldProcess('pull_request', makePayload({ action: 'closed' }), DEFAULT_CONFIG);
      expect(result.process).toBe(false);
    });

    it('blocks "labeled" action', () => {
      const result = shouldProcess('pull_request', makePayload({ action: 'labeled' }), DEFAULT_CONFIG);
      expect(result.process).toBe(false);
    });

    it('blocks non-pull_request event type', () => {
      const result = shouldProcess('push', makePayload({ action: 'opened' }), DEFAULT_CONFIG);
      expect(result.process).toBe(false);
    });
  });

  // INTK-03: repo allowlist
  describe('repo allowlist (INTK-03)', () => {
    it('blocks a repo not in the allowlist', () => {
      const config = { ...DEFAULT_CONFIG, repos: ['owner/allowed'] };
      const result = shouldProcess(
        'pull_request',
        makePayload({ repoFullName: 'owner/blocked' }),
        config,
      );
      expect(result.process).toBe(false);
    });

    it('passes a repo that is in the allowlist', () => {
      const config = { ...DEFAULT_CONFIG, repos: ['owner/allowed'] };
      const result = shouldProcess(
        'pull_request',
        makePayload({ repoFullName: 'owner/allowed' }),
        config,
      );
      expect(result.process).toBe(true);
    });

    it('passes any repo when allowlist is empty (App-installation boundary)', () => {
      const config = { ...DEFAULT_CONFIG, repos: [] };
      const result = shouldProcess(
        'pull_request',
        makePayload({ repoFullName: 'any/repo' }),
        config,
      );
      expect(result.process).toBe(true);
    });
  });

  // INTK-03: draft filter
  describe('draft filter (INTK-03)', () => {
    it('blocks draft PRs when skipDrafts=true', () => {
      const config = { ...DEFAULT_CONFIG, skipDrafts: true };
      const result = shouldProcess('pull_request', makePayload({ draft: true }), config);
      expect(result.process).toBe(false);
    });

    it('passes draft PRs when skipDrafts=false', () => {
      const config = { ...DEFAULT_CONFIG, skipDrafts: false };
      const result = shouldProcess('pull_request', makePayload({ draft: true }), config);
      expect(result.process).toBe(true);
    });

    it('passes non-draft PRs when skipDrafts=true', () => {
      const config = { ...DEFAULT_CONFIG, skipDrafts: true };
      const result = shouldProcess('pull_request', makePayload({ draft: false }), config);
      expect(result.process).toBe(true);
    });
  });

  // INTK-03: fork filter
  describe('fork filter (INTK-03)', () => {
    it('blocks fork PRs when skipForks=true (head repo differs from base repo)', () => {
      const config = { ...DEFAULT_CONFIG, skipForks: true };
      const result = shouldProcess(
        'pull_request',
        makePayload({
          headRepo: 'forker/repo',
          baseRepo: 'owner/repo',
        }),
        config,
      );
      expect(result.process).toBe(false);
    });

    it('passes fork PRs when skipForks=false', () => {
      const config = { ...DEFAULT_CONFIG, skipForks: false };
      const result = shouldProcess(
        'pull_request',
        makePayload({
          headRepo: 'forker/repo',
          baseRepo: 'owner/repo',
        }),
        config,
      );
      expect(result.process).toBe(true);
    });

    it('passes same-repo PRs when skipForks=true', () => {
      const config = { ...DEFAULT_CONFIG, skipForks: true };
      const result = shouldProcess(
        'pull_request',
        makePayload({
          headRepo: 'owner/repo',
          baseRepo: 'owner/repo',
        }),
        config,
      );
      expect(result.process).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Phase 5: appConnected opt-in semantics (D5-07)
// These tests will FAIL RED until Plan 02 adds appConnected to shouldProcess.
// ---------------------------------------------------------------------------

/**
 * D5-07: When appConnected=true (github_app_slug setting present), the repo list
 * becomes authoritative: empty list means "review nothing" (strict opt-in).
 * When appConnected=false (manual/env mode), the existing empty=allow-all behavior
 * is preserved -- this must NEVER regress.
 */
describe('appConnected opt-in semantics (D5-07)', () => {
  it('blocks all repos when appConnected=true and repos list is empty', () => {
    // RED: shouldProcess ignores appConnected today; this case currently passes
    // After Plan 02: appConnected=true + empty repos -> block with opt-in reason
    const config: FilterConfig = { ...DEFAULT_CONFIG, appConnected: true, repos: [] };
    const result = shouldProcess('pull_request', makePayload({ repoFullName: 'any/repo' }), config);
    expect(result.process).toBe(false);
    expect(result.reason).toContain('opt-in');
  });

  it('passes a repo that is in the allowlist when appConnected=true', () => {
    // After Plan 02: appConnected=true + matching repo -> allow
    const config: FilterConfig = { ...DEFAULT_CONFIG, appConnected: true, repos: ['owner/repo'] };
    const result = shouldProcess('pull_request', makePayload({ repoFullName: 'owner/repo' }), config);
    expect(result.process).toBe(true);
  });

  it('blocks a repo not in the allowlist when appConnected=true', () => {
    // After Plan 02: appConnected=true + non-matching repo -> block
    const config: FilterConfig = { ...DEFAULT_CONFIG, appConnected: true, repos: ['owner/other'] };
    const result = shouldProcess('pull_request', makePayload({ repoFullName: 'owner/repo' }), config);
    expect(result.process).toBe(false);
  });

  it('preserves empty=allow-all behavior when appConnected=false (manual mode)', () => {
    // This must ALWAYS pass (manual-mode regression guard, SC-5 / D5-07)
    const config: FilterConfig = { ...DEFAULT_CONFIG, appConnected: false, repos: [] };
    const result = shouldProcess('pull_request', makePayload({ repoFullName: 'any/repo' }), config);
    expect(result.process).toBe(true);
  });
});
