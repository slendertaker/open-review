/**
 * Startup safety gate tests (ENGN-07, D-08)
 *
 * Tests assertClaudeVersion() and assertSqliteVersion() from src/startup.ts.
 * Both functions must throw if the version is below the minimum threshold,
 * and pass silently when at or above the minimum.
 *
 * assertClaudeVersion() accepts an optional execFileFn override for mocking.
 * assertSqliteVersion() accepts a Database instance (uses in-memory SQLite).
 */

import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import {
  assertClaudeVersion,
  assertSqliteVersion,
} from '../src/startup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build an execFileFn mock that returns the given stdout string. */
function makeExecFile(stdout: string): (
  cmd: string,
  args: string[],
  cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
) => void {
  return (_cmd, _args, cb) => cb(null, { stdout, stderr: '' });
}

/** Build an execFileFn mock that simulates the binary not being found. */
function makeExecFileError(message: string): (
  cmd: string,
  args: string[],
  cb: (err: Error | null, result: { stdout: string; stderr: string }) => void,
) => void {
  return (_cmd, _args, cb) => cb(new Error(message), { stdout: '', stderr: '' });
}

/** In-memory DB with a real SQLite version (must be >= 3.35 in dev). */
function createTestDb(): Database.Database {
  return new Database(':memory:');
}

// ---------------------------------------------------------------------------
// assertClaudeVersion tests
// ---------------------------------------------------------------------------

describe('assertClaudeVersion (ENGN-07)', () => {
  it('passes when claude reports exactly 2.1.163', async () => {
    const execFile = makeExecFile('Claude Code 2.1.163\n');
    await expect(assertClaudeVersion(execFile)).resolves.toBeUndefined();
  });

  it('passes when claude reports a version above 2.1.163', async () => {
    const execFile = makeExecFile('Claude Code 2.1.195\n');
    await expect(assertClaudeVersion(execFile)).resolves.toBeUndefined();
  });

  it('passes for a higher minor version (2.2.0)', async () => {
    const execFile = makeExecFile('Claude Code 2.2.0\n');
    await expect(assertClaudeVersion(execFile)).resolves.toBeUndefined();
  });

  it('throws when claude reports 2.1.162 (one below minimum)', async () => {
    const execFile = makeExecFile('Claude Code 2.1.162\n');
    await expect(assertClaudeVersion(execFile)).rejects.toThrow(/2\.1\.163/);
  });

  it('throws when claude reports 2.0.999 (major series below minimum)', async () => {
    const execFile = makeExecFile('Claude Code 2.0.999\n');
    await expect(assertClaudeVersion(execFile)).rejects.toThrow(/2\.1\.163/);
  });

  it('throws when claude reports 1.9.999 (lower major)', async () => {
    const execFile = makeExecFile('Claude Code 1.9.999\n');
    await expect(assertClaudeVersion(execFile)).rejects.toThrow(/2\.1\.163/);
  });

  it('throws when claude binary is not found', async () => {
    const execFile = makeExecFileError('ENOENT: no such file or directory');
    await expect(assertClaudeVersion(execFile)).rejects.toThrow();
  });

  it('throws when claude reports an unparseable version string', async () => {
    const execFile = makeExecFile('not a version\n');
    await expect(assertClaudeVersion(execFile)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// assertSqliteVersion tests
// ---------------------------------------------------------------------------

/**
 * Build a minimal Database-like object for testing assertSqliteVersion
 * without spawning a real DB or patching the generic-overloaded prepare method.
 */
function makeMockDb(version: string): Database.Database {
  return {
    prepare: (_sql: string) => ({
      get: () => ({ version }),
    }),
  } as unknown as Database.Database;
}

describe('assertSqliteVersion (Pitfall 8)', () => {
  it('passes with the real in-memory SQLite (must be >= 3.35 on dev machine)', () => {
    const db = createTestDb();
    expect(() => assertSqliteVersion(db)).not.toThrow();
    db.close();
  });

  it('throws when SQLite version is 3.34.1 (one below minimum)', () => {
    expect(() => assertSqliteVersion(makeMockDb('3.34.1'))).toThrow(/3\.35/);
  });

  it('throws when SQLite version is 3.0.0', () => {
    expect(() => assertSqliteVersion(makeMockDb('3.0.0'))).toThrow(/3\.35/);
  });

  it('passes when SQLite version is exactly 3.35.0', () => {
    expect(() => assertSqliteVersion(makeMockDb('3.35.0'))).not.toThrow();
  });

  it('passes when SQLite version is 3.43.2 (common on macOS)', () => {
    expect(() => assertSqliteVersion(makeMockDb('3.43.2'))).not.toThrow();
  });

  it('passes when SQLite version is 4.0.0', () => {
    expect(() => assertSqliteVersion(makeMockDb('4.0.0'))).not.toThrow();
  });
});
