/**
 * ReviewProvider interface and shared types (D-03).
 *
 * The ReviewProvider is the only provider-aware seam in the system.
 * Webhook, queue, and poster code must import only the shared Finding type,
 * never anything from a concrete provider implementation.
 */

import type { Finding, ParsedOutput } from './parser.js';

export type { Finding, ParsedOutput };

/** Context passed to buildPrompt by the pipeline. */
export interface ReviewContext {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  diff: string;
  worktreeDir: string;
  incremental?: boolean;
  guidelines?: { file: string; content: string };
}

/** Raw output from running the review subprocess. */
export interface RawOutput {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * The ReviewProvider interface (D-03).
 *
 * A provider owns CLI flag assembly, sandbox env construction, and output parsing.
 * Everything else (webhook, queue, posting) is provider-agnostic.
 *
 * Phase 1 ships only ClaudeProvider. The Codex provider (v2) drops in with zero
 * changes to webhook/queue/poster.
 *
 * To add a new provider (e.g. CodexProvider):
 *   1. Implement this interface in src/provider/codex.ts.
 *   2. Register it in getProvider() in src/provider/index.ts.
 *   No pipeline, webhook, queue, or poster changes required.
 */
export interface ReviewProvider {
  /** Build the text prompt from the review context. */
  buildPrompt(ctx: ReviewContext): string;
  /**
   * Invoke the review subprocess and return raw output.
   * The provider owns CLI flag assembly and sandbox env construction -- the
   * caller supplies only the human-readable prompt, the worktree path, and
   * (Phase 2+) the resolved Claude credential from the config store.
   *
   * credential: the single resolved auth token (D-05 precedence: OAuth first,
   * then API key). When undefined, the provider falls back to process.env so
   * Phase 1 env-only installs continue to work without a restart (D2-05).
   */
  invoke(prompt: string, worktreeDir: string, credential?: string): Promise<RawOutput>;
  /** Parse raw subprocess output into typed findings + summary. */
  parseOutput(raw: RawOutput): ParsedOutput;
}
