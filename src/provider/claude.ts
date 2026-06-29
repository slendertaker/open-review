/**
 * ClaudeProvider: implements ReviewProvider for Claude Code CLI (D-03, D-05, D-06, D-09, D-10).
 *
 * Security contracts:
 *   D-06: --bare is NEVER passed (it ignores CLAUDE_CODE_OAUTH_TOKEN).
 *   D-09: --allowedTools scoped to read-only + worktree-anchored git; --disallowedTools
 *         blocks Edit/Write/WebFetch/WebSearch; --permission-mode dontAsk.
 *   D-09 Layer 2: --settings points to config/review-settings.json (ABSOLUTE path)
 *         so the PreToolUse hook is always loaded regardless of cwd.
 *   D-10: buildSandboxEnv passes only PATH/HOME/USER + exactly one credential.
 *         GITHUB_TOKEN, WEBHOOK_SECRET, and GITHUB_APP_PRIVATE_KEY are NEVER
 *         passed to the child process.
 *   cwd: always PROJECT_ROOT so the relative hook path in review-settings.json resolves.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReviewProvider, RawOutput, ParsedOutput, ReviewContext } from './types.js';
import { parseClaudeOutput, FINDINGS_SCHEMA } from './parser.js';
import { scrub } from '../logger.js';
import { RateLimitError } from '../queue/types.js';

// ---------------------------------------------------------------------------
// Project root resolution
// ---------------------------------------------------------------------------

/**
 * PROJECT_ROOT is the directory that contains config/review-settings.json and
 * .claude/hooks/. This is the cwd for `claude -p` so the relative hook path
 * ("bash .claude/hooks/enforce-readonly.sh") in review-settings.json resolves.
 *
 * OPEN_REVIEW_ROOT override is used by the systemd unit / installer (dist layout).
 */
export const PROJECT_ROOT: string =
  process.env['OPEN_REVIEW_ROOT'] ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Wall-clock timeout per review run. */
export const RUNNER_TIMEOUT_MS = 5 * 60 * 1000;

/** Cap agentic turns to prevent runaway exploration. */
export const MAX_TURNS = 20;

// ---------------------------------------------------------------------------
// buildClaudeArgs
// ---------------------------------------------------------------------------

/**
 * Build the full argument array for `claude -p`.
 *
 * Key safety decisions:
 *   --bare is NEVER passed (D-06, ENGN-04).
 *   --settings is an ABSOLUTE path resolved from PROJECT_ROOT (D-09, Pitfall 3).
 *   --add-dir grants file access to the worktree without changing cwd.
 *   --allowedTools scopes git Bash patterns to the PR worktree (no host-repo access).
 *   --json-schema passes FINDINGS_SCHEMA (D-07, single source of truth).
 */
export function buildClaudeArgs(prompt: string, worktreeDir: string): string[] {
  // Absolute path to the settings file -- never relative (Pitfall 3).
  const settingsPath = path.resolve(PROJECT_ROOT, 'config', 'review-settings.json');

  // Bash patterns scoped to the PR worktree so Claude cannot run git against PROJECT_ROOT.
  const allowedTools = [
    'Read',
    'Glob',
    'Grep',
    `Bash(git -C ${worktreeDir} diff *)`,
    `Bash(git -C ${worktreeDir} log *)`,
    `Bash(git -C ${worktreeDir} show *)`,
    `Bash(git -C ${worktreeDir} status *)`,
  ].join(',');

  return [
    '-p', prompt,
    '--settings', settingsPath,
    '--add-dir', worktreeDir,
    '--allowedTools', allowedTools,
    '--disallowedTools', 'Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch',
    '--permission-mode', 'dontAsk',
    '--output-format', 'json',
    '--json-schema', FINDINGS_SCHEMA,
    '--max-turns', String(MAX_TURNS),
    '--no-session-persistence',
  ];
}

// ---------------------------------------------------------------------------
// buildSandboxEnv
// ---------------------------------------------------------------------------

/**
 * Construct a minimal child process env with exactly one auth token.
 *
 * D-10: Only PATH/HOME/USER + one credential. No GITHUB_TOKEN, WEBHOOK_SECRET,
 * or GITHUB_APP_PRIVATE_KEY ever reach the child process.
 *
 * When useOAuth=true:  CLAUDE_CODE_OAUTH_TOKEN set to token, ANTHROPIC_API_KEY absent.
 * When useOAuth=false: ANTHROPIC_API_KEY set to token, CLAUDE_CODE_OAUTH_TOKEN absent.
 *
 * token: the resolved credential value from the caller (D-05 precedence: OAuth first,
 * then API key). The token is the ONLY secret value sourced from outside this function.
 * process.env is never spread into the child env (T-02-18).
 */
export function buildSandboxEnv(useOAuth: boolean, token: string): NodeJS.ProcessEnv {
  // Start from scratch -- never spread process.env to avoid leaking host secrets.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    USER: process.env['USER'],
  };

  // Add exactly one credential (mutual exclusion -- T-01-I1, D-05).
  if (useOAuth) {
    env['CLAUDE_CODE_OAUTH_TOKEN'] = token;
    // ANTHROPIC_API_KEY intentionally absent -- OAuth is the primary auth (D-05).
  } else {
    env['ANTHROPIC_API_KEY'] = token;
    // CLAUDE_CODE_OAUTH_TOKEN intentionally absent -- API key fallback.
  }

  // Enable the Claude Code built-in retry watchdog so transient 429/529 errors
  // are transparently retried by the CLI before we ever see exit code 29 (D-07).
  // A persistent rate-limit that exhausts retries still surfaces as exit 29.
  env['CLAUDE_CODE_RETRY_WATCHDOG'] = '1';

  // Defensive deletions: these must NEVER appear in the child env (D-10).
  // (Not in the object above, but delete defensively in case of future refactors.)
  delete env['GITHUB_TOKEN'];
  delete env['WEBHOOK_SECRET'];
  delete env['OPEN_REVIEW_WEBHOOK_SECRET'];
  delete env['GITHUB_APP_PRIVATE_KEY'];
  delete env['GITHUB_APP_PRIVATE_KEY_PATH'];

  return env;
}

// ---------------------------------------------------------------------------
// isAuthError
// ---------------------------------------------------------------------------

function isAuthError(stderr: string): boolean {
  return /authentication.failed|401|unauthorized|oauth.*not.*allowed|billing.error/i.test(stderr);
}

// ---------------------------------------------------------------------------
// spawnClaude (internal)
// ---------------------------------------------------------------------------

async function spawnClaude(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<RawOutput> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      cwd: PROJECT_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const MAX_BUF = 10 * 1024 * 1024; // 10 MB cap

    proc.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_BUF) stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_BUF) stderr += chunk.toString();
    });

    proc.on('error', reject);

    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      killTimer = setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, RUNNER_TIMEOUT_MS);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve({
        exitCode: timedOut ? 1 : (code ?? 1),
        stdout,
        stderr: timedOut ? stderr + '\n[runner: wall-clock timeout]' : stderr,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// runWithAuthFallback
// ---------------------------------------------------------------------------

/**
 * Detect a persistent provider rate limit from the process exit code.
 *
 * Phase 1 signal: exit code 29 + optional "retry-after: N" in stderr/stdout (D-07,
 * Open Question 1 resolution). CLAUDE_CODE_RETRY_WATCHDOG=1 handles transient 429/529
 * inside the CLI before we see exit 29, so exit 29 means the CLI exhausted its own retries.
 *
 * Documented fallback (not implemented -- keep it simple per Open Question 1):
 *   If exit-29 semantics change in a future CLI release, switch to --output-format stream-json
 *   and parse the `system/api_retry` event (error: rate_limit) for the retry-after value.
 */
function checkRateLimit(result: RawOutput): RawOutput {
  if (result.exitCode === 29) {
    const match = /retry-after:\s*(\d+)/i.exec(result.stderr + result.stdout);
    const retryAfterMs = match ? Number(match[1]) * 1000 : 60_000;
    throw new RateLimitError(retryAfterMs);
  }
  return result;
}

/**
 * Run claude -p with OAuth-first auth, falling back to API-key-only on auth failure (D-05).
 *
 * oauthToken: the resolved OAuth token to try first. When undefined, falls back to
 *   process.env['CLAUDE_CODE_OAUTH_TOKEN'] so Phase 1 env-only installs work.
 * apiKey: the resolved API key for fallback. When undefined, falls back to
 *   process.env['ANTHROPIC_API_KEY'].
 *
 * D-05 precedence: OAuth first. If the OAuth attempt fails with an auth error,
 * the API key is used. If both are absent, the first attempt will fail and the
 * fallback will also fail (the CLI handles the missing-creds error).
 */
export async function runWithAuthFallback(
  args: string[],
  oauthToken?: string,
  apiKey?: string,
): Promise<RawOutput> {
  // Resolve actual token values: store-supplied credential wins; process.env is last-resort.
  const resolvedOauth = oauthToken ?? process.env['CLAUDE_CODE_OAUTH_TOKEN'];
  const resolvedApiKey = apiKey ?? process.env['ANTHROPIC_API_KEY'];

  // Only attempt OAuth if we have an OAuth token.
  if (resolvedOauth) {
    const result = checkRateLimit(
      await spawnClaude(args, buildSandboxEnv(true, resolvedOauth)),
    );

    if (result.exitCode === 1 && isAuthError(result.stderr)) {
      // OAuth failed -- fall back to API key if available.
      if (resolvedApiKey) {
        return checkRateLimit(
          await spawnClaude(args, buildSandboxEnv(false, resolvedApiKey)),
        );
      }
    }

    return result;
  }

  // No OAuth token: attempt with API key directly (single try, no fallback).
  const fallbackKey = resolvedApiKey ?? '';
  return checkRateLimit(
    await spawnClaude(args, buildSandboxEnv(false, fallbackKey)),
  );
}

// ---------------------------------------------------------------------------
// ClaudeProvider (implements ReviewProvider)
// ---------------------------------------------------------------------------

/**
 * Claude Code CLI provider (Phase 1). Implements the ReviewProvider interface (D-03).
 * Webhook, queue, and poster code must NOT import this class directly -- they use
 * the shared Finding type and the ReviewProvider seam only.
 */
export class ClaudeProvider implements ReviewProvider {
  buildPrompt(ctx: ReviewContext): string {
    // Delegate to the prompt builder in worker/prompt.ts via the pipeline.
    // The ClaudeProvider itself is thin -- the pipeline wires the diff/guidelines.
    return ctx.diff;
  }

  /**
   * Invoke the Claude CLI review subprocess.
   *
   * credential: the store-resolved auth token from runReview (D-05 precedence: OAuth
   * first, then API key as fallback). The pipeline resolves which token is primary
   * and passes the selected token here. If the token is a CLAUDE_CODE_OAUTH_TOKEN
   * value, pass it as oauthToken; if it is an ANTHROPIC_API_KEY value, it goes in
   * as the apiKey fallback.
   *
   * When credential is undefined (Phase 1 env-only install), process.env is the
   * last-resort fallback inside runWithAuthFallback (D-05 backward-compat).
   *
   * The credential string is opaque to invoke(). The pipeline encodes the credential
   * type by calling invokeResolved() with explicit (oauthToken, apiKey) so D-05
   * OAuth-first ordering is preserved. This invoke() shim delegates to invokeResolved().
   */
  async invoke(prompt: string, worktreeDir: string, credential?: string): Promise<RawOutput> {
    // Phase 1 compatibility shim: when credential is absent, fall back to process.env.
    // For Phase 2+ the pipeline uses invokeResolved() directly.
    return runWithAuthFallback(buildClaudeArgs(prompt, worktreeDir), credential, undefined);
  }

  /**
   * Invoke with typed credentials resolved by the pipeline (D-05, T-02-18).
   *
   * oauthToken: store.claudeOauthToken (primary per D-05); undefined if not stored.
   * apiKey: store.anthropicApiKey (fallback per D-05); undefined if not stored.
   *
   * runWithAuthFallback tries OAuth first; falls back to API key on auth failure.
   * When both are undefined, it falls back to process.env (last-resort for env-only
   * installs so Phase 1 setups continue to work without restart).
   */
  async invokeResolved(
    prompt: string,
    worktreeDir: string,
    oauthToken: string | undefined,
    apiKey: string | undefined,
  ): Promise<RawOutput> {
    return runWithAuthFallback(buildClaudeArgs(prompt, worktreeDir), oauthToken, apiKey);
  }

  parseOutput(raw: RawOutput): ParsedOutput {
    return parseClaudeOutput(raw.stdout, raw.stderr);
  }
}
