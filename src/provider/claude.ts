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
 * When useOAuth=true:  CLAUDE_CODE_OAUTH_TOKEN set, ANTHROPIC_API_KEY absent.
 * When useOAuth=false: ANTHROPIC_API_KEY set, CLAUDE_CODE_OAUTH_TOKEN absent.
 */
export function buildSandboxEnv(useOAuth: boolean): NodeJS.ProcessEnv {
  // Start from scratch -- never spread process.env to avoid leaking host secrets.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    USER: process.env['USER'],
  };

  // Add exactly one credential (mutual exclusion -- T-01-I1).
  if (useOAuth) {
    env['CLAUDE_CODE_OAUTH_TOKEN'] = process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    // ANTHROPIC_API_KEY intentionally absent -- OAuth is the primary auth (D-05).
  } else {
    env['ANTHROPIC_API_KEY'] = process.env['ANTHROPIC_API_KEY'];
    // CLAUDE_CODE_OAUTH_TOKEN intentionally absent -- API key fallback.
  }

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
 */
export async function runWithAuthFallback(args: string[]): Promise<RawOutput> {
  const result = checkRateLimit(
    await spawnClaude(args, buildSandboxEnv(true)),
  );

  if (result.exitCode === 1 && isAuthError(result.stderr)) {
    return checkRateLimit(
      await spawnClaude(args, buildSandboxEnv(false)),
    );
  }

  return result;
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

  async invoke(args: string[]): Promise<RawOutput> {
    return runWithAuthFallback(args);
  }

  parseOutput(raw: RawOutput): ParsedOutput {
    return parseClaudeOutput(raw.stdout, raw.stderr);
  }
}
