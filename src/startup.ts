/**
 * Startup safety gates (D-08, ENGN-07, Pitfall 8).
 *
 * Both assertions must be called BEFORE server.listen() and BEFORE the drain
 * loop starts, so an unsafe environment never accepts a webhook or runs a review.
 *
 * assertSqliteVersion(db)
 *   SELECT sqlite_version(); parse; throw if < 3.35 (RETURNING support).
 *
 * assertClaudeVersion(execFileFn?)
 *   Run `claude --version`; parse semver; throw if < 2.1.163 (CVE-2026-55607).
 *   The optional execFileFn parameter is injected in unit tests to avoid spawning
 *   a real claude binary.
 */

import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback-style execFile signature (subset used by assertClaudeVersion). */
export type ExecFileCallback = (
  cmd: string,
  args: string[],
  cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
) => void;

// ---------------------------------------------------------------------------
// Version comparison helper
// ---------------------------------------------------------------------------

/**
 * Parse a "MAJOR.MINOR.PATCH" string into a numeric triple.
 * Returns null if the string cannot be parsed.
 */
function parseSemver(versionStr: string): [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(versionStr);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Return true if actual >= required (semver comparison, no pre-release).
 */
function semverGte(actual: [number, number, number], required: [number, number, number]): boolean {
  if (actual[0] !== required[0]) return actual[0] > required[0];
  if (actual[1] !== required[1]) return actual[1] > required[1];
  return actual[2] >= required[2];
}

// ---------------------------------------------------------------------------
// assertSqliteVersion
// ---------------------------------------------------------------------------

/** Minimum SQLite version required for UPDATE...RETURNING (Pitfall 8). */
export const SQLITE_MIN_VERSION = '3.35.0';

/**
 * Assert the SQLite library version is >= 3.35.0.
 * Throws a descriptive error if not, so the process refuses to start.
 */
export function assertSqliteVersion(db: Database.Database): void {
  const row = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
  const actual = parseSemver(row.version);
  const required = parseSemver(SQLITE_MIN_VERSION)!;

  if (!actual || !semverGte(actual, required)) {
    throw new Error(
      `SQLite version ${row.version} is below the minimum required ${SQLITE_MIN_VERSION}. ` +
        'UPDATE...RETURNING is not supported on this version. Please upgrade SQLite.',
    );
  }
}

// ---------------------------------------------------------------------------
// assertClaudeVersion
// ---------------------------------------------------------------------------

/** Minimum Claude Code CLI version required (CVE-2026-55607 sandbox escape fix). */
export const CLAUDE_MIN_VERSION = '2.1.163';

/**
 * Assert the claude CLI version is >= 2.1.163 (ENGN-07, CVE-2026-55607).
 *
 * @param execFileFn - Optional dependency injection for testing. Defaults to
 *   node:child_process.execFile so no real binary is needed in unit tests.
 */
export async function assertClaudeVersion(execFileFn?: ExecFileCallback): Promise<void> {
  const exec = execFileFn
    ? promisify(execFileFn as Parameters<typeof promisify>[0])
    : promisify(nodeExecFile);

  let stdout: string;
  try {
    const result = await exec('claude', ['--version']) as { stdout: string; stderr: string };
    stdout = result.stdout;
  } catch (err: unknown) {
    throw new Error(
      `Failed to run 'claude --version': ${String(err)}. ` +
        `Ensure the Claude Code CLI >= ${CLAUDE_MIN_VERSION} is installed and on PATH.`,
    );
  }

  const actual = parseSemver(stdout);
  if (!actual) {
    throw new Error(
      `Could not parse Claude Code CLI version from output: ${JSON.stringify(stdout)}. ` +
        `Expected a version string containing MAJOR.MINOR.PATCH >= ${CLAUDE_MIN_VERSION}.`,
    );
  }

  const required = parseSemver(CLAUDE_MIN_VERSION)!;
  if (!semverGte(actual, required)) {
    throw new Error(
      `Claude Code CLI version ${actual.join('.')} is below the minimum required ` +
        `${CLAUDE_MIN_VERSION} (CVE-2026-55607 sandbox escape fix). ` +
        'Please upgrade: npm install -g @anthropic-ai/claude-code',
    );
  }
}
