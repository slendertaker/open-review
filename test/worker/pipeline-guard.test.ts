/**
 * Unit tests for the trust-critical pipeline guard helpers (T-jr6-01, T-jr6-02).
 *
 * Tests the two pure exported helpers from src/worker/pipeline.ts:
 *   - assertProviderSucceeded: throws on non-zero exit with scrubbed bounded tail
 *   - formatRunLog: builds real output string (never "[object Object]")
 *
 * runReview itself is NOT invoked -- it requires git worktrees, octokit, and
 * postReview. The pure helpers are the trust-critical seam and are sufficient.
 */

import { describe, it, expect } from 'vitest';
import { assertProviderSucceeded, formatRunLog } from '../../src/worker/pipeline.js';
import type { RawOutput } from '../../src/provider/types.js';

// ---------------------------------------------------------------------------
// assertProviderSucceeded
// ---------------------------------------------------------------------------

describe('assertProviderSucceeded (T-jr6-01)', () => {
  it('exit 0 with valid structured_output JSON in stdout does not throw', () => {
    const out: RawOutput = {
      exitCode: 0,
      stdout: JSON.stringify({ subtype: 'success', structured_output: { findings: [], summary: 'Clean.' } }),
      stderr: '',
    };
    expect(() => assertProviderSucceeded(out)).not.toThrow();
  });

  it('exit 0 with empty stdout does not throw (clean path gated only on exit code)', () => {
    const out: RawOutput = { exitCode: 0, stdout: '', stderr: '' };
    expect(() => assertProviderSucceeded(out)).not.toThrow();
  });

  it('exit 1 with empty stdout and empty stderr throws with "(no output)" in message', () => {
    const out: RawOutput = { exitCode: 1, stdout: '', stderr: '' };
    expect(() => assertProviderSucceeded(out)).toThrow(/provider exited with code 1/);
    expect(() => assertProviderSucceeded(out)).toThrow(/\(no output\)/);
  });

  it('exit 1 with 401 message in stderr surfaces stderr text in thrown error', () => {
    // Note: "bearer token" is matched by the scrub regex (case-insensitive Bearer pattern)
    // so the message contains "401 Invalid [REDACTED]" rather than the raw text.
    // What matters is that stderr content is surfaced (not empty "(no output)") and
    // the non-scrubbed portion of the 401 error message is present.
    const authErr = 'Failed to authenticate. API Error: 401 Invalid bearer token';
    const out: RawOutput = { exitCode: 1, stdout: '', stderr: authErr };
    let caught: Error | null = null;
    try {
      assertProviderSucceeded(out);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toContain('provider exited with code 1');
    // The non-scrubbed portion of the error (API error code) must appear in the message
    expect(caught!.message).toContain('API Error: 401');
    // The message must not be the empty-output fallback -- stderr was surfaced
    expect(caught!.message).not.toContain('(no output)');
  });

  it('exit 1 with a credential token in stderr redacts it via scrub()', () => {
    // Use a value matching the scrub regex (sk-ant- prefix)
    const rawToken = 'sk-ant-api03-SuperSecretTokenAbcDef1234567890XYZ';
    const out: RawOutput = { exitCode: 1, stdout: '', stderr: `Auth failed: ${rawToken}` };
    let caught: Error | null = null;
    try {
      assertProviderSucceeded(out);
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).not.toBeNull();
    // The raw token must be scrubbed
    expect(caught!.message).not.toContain(rawToken);
    // scrub() replaces with [REDACTED]
    expect(caught!.message).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// formatRunLog
// ---------------------------------------------------------------------------

describe('formatRunLog (T-jr6-02)', () => {
  it('contains logMeta, exit=0, and stdout content; never "[object Object]"', () => {
    const logMeta = '{"repo":"owner/repo","prNumber":42}';
    const out: RawOutput = {
      exitCode: 0,
      stdout: '{"summary":"clean review output"}',
      stderr: '',
    };
    const result = formatRunLog(logMeta, out);
    expect(result).toContain(logMeta);
    expect(result).toContain('exit=0');
    expect(result).toContain('clean review output');
    expect(result).not.toContain('[object Object]');
  });

  it('includes stderr content prefixed with "stderr:" when stderr is non-empty', () => {
    const logMeta = '{"repo":"owner/repo","prNumber":1}';
    const out: RawOutput = {
      exitCode: 1,
      stdout: '',
      stderr: 'Some warning from the subprocess',
    };
    const result = formatRunLog(logMeta, out);
    expect(result).toContain('stderr:');
    expect(result).toContain('Some warning from the subprocess');
  });

  it('does not include "stderr:" section when stderr is whitespace only', () => {
    const logMeta = '{}';
    const out: RawOutput = { exitCode: 0, stdout: 'ok', stderr: '   ' };
    const result = formatRunLog(logMeta, out);
    expect(result).not.toContain('stderr:');
  });
});
