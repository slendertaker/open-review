/**
 * Wave 0 test: Claude sandbox argument and env construction
 * Requirements: ENGN-04, ENGN-05
 *
 * Tests buildClaudeArgs and buildSandboxEnv from src/provider/claude.ts.
 * The security-load-bearing negative assertion: args must NOT contain --bare.
 * The env isolation assertion: GITHUB_TOKEN, WEBHOOK_SECRET, and GITHUB_APP_PRIVATE_KEY
 * must never appear in the child env; exactly one auth credential must be present.
 *
 * All imports use .js extension per NodeNext ESM resolution.
 */

import { describe, it, expect } from 'vitest';
import { buildClaudeArgs, buildSandboxEnv } from '../../src/provider/claude.js';

const FAKE_WORKTREE = '/tmp/open-review-worktrees/owner-repo-abc1234';
const FAKE_PROMPT = 'Review this PR diff for security issues.';

describe('buildClaudeArgs (ENGN-04)', () => {
  let args: string[];

  // Run once for the whole block
  // (vitest runs describes synchronously so we can set in outer scope)
  args = [];
  try {
    args = buildClaudeArgs(FAKE_PROMPT, FAKE_WORKTREE);
  } catch {
    // Will fail with import error in RED state; tests below will still be reported
  }

  it('does NOT contain --bare (security-load-bearing negative, D-06)', () => {
    expect(args).not.toContain('--bare');
  });

  it('contains --settings with an absolute path', () => {
    const settingsIdx = args.indexOf('--settings');
    expect(settingsIdx).toBeGreaterThan(-1);
    const settingsPath = args[settingsIdx + 1];
    expect(settingsPath).toBeDefined();
    // Must be an absolute path (starts with /)
    expect(settingsPath!.startsWith('/')).toBe(true);
  });

  it('contains --allowedTools', () => {
    expect(args).toContain('--allowedTools');
  });

  it('allowedTools value includes git patterns scoped to the worktree dir', () => {
    const toolsIdx = args.indexOf('--allowedTools');
    const toolsVal = args[toolsIdx + 1] ?? '';
    // The worktree path should appear in the Bash(git -C <worktree> ...) patterns
    expect(toolsVal).toContain(FAKE_WORKTREE);
  });

  it('contains --disallowedTools', () => {
    expect(args).toContain('--disallowedTools');
  });

  it('contains --permission-mode dontAsk', () => {
    const pmIdx = args.indexOf('--permission-mode');
    expect(pmIdx).toBeGreaterThan(-1);
    expect(args[pmIdx + 1]).toBe('dontAsk');
  });

  it('contains --output-format json', () => {
    const ofIdx = args.indexOf('--output-format');
    expect(ofIdx).toBeGreaterThan(-1);
    expect(args[ofIdx + 1]).toBe('json');
  });

  it('contains --json-schema', () => {
    expect(args).toContain('--json-schema');
  });

  it('contains --add-dir with the worktree path', () => {
    const adIdx = args.indexOf('--add-dir');
    expect(adIdx).toBeGreaterThan(-1);
    expect(args[adIdx + 1]).toBe(FAKE_WORKTREE);
  });
});

describe('buildSandboxEnv (ENGN-05)', () => {
  it('returns an object with PATH, HOME, and USER', () => {
    // Temporarily set env vars if not present
    const saved = {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      USER: process.env['USER'],
      CLAUDE_CODE_OAUTH_TOKEN: process.env['CLAUDE_CODE_OAUTH_TOKEN'],
    };
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'fake-oauth-token';

    const env = buildSandboxEnv(true);
    expect(env['PATH']).toBeDefined();
    expect(env['HOME']).toBeDefined();
    expect(env['USER']).toBeDefined();

    // Restore
    Object.assign(process.env, saved);
  });

  it('includes CLAUDE_CODE_OAUTH_TOKEN and not ANTHROPIC_API_KEY when useOAuth=true', () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-oauth-token';
    process.env['ANTHROPIC_API_KEY'] = 'test-api-key';

    const env = buildSandboxEnv(true);
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeDefined();
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();

    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('includes ANTHROPIC_API_KEY and not CLAUDE_CODE_OAUTH_TOKEN when useOAuth=false', () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = 'test-oauth-token';
    process.env['ANTHROPIC_API_KEY'] = 'test-api-key';

    const env = buildSandboxEnv(false);
    expect(env['ANTHROPIC_API_KEY']).toBeDefined();
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined();

    delete process.env['CLAUDE_CODE_OAUTH_TOKEN'];
    delete process.env['ANTHROPIC_API_KEY'];
  });

  it('never includes GITHUB_TOKEN (secret isolation, ENGN-05)', () => {
    process.env['GITHUB_TOKEN'] = 'ghs_secret';
    const env = buildSandboxEnv(true);
    expect(env['GITHUB_TOKEN']).toBeUndefined();
    delete process.env['GITHUB_TOKEN'];
  });

  it('never includes WEBHOOK_SECRET (secret isolation, ENGN-05)', () => {
    process.env['WEBHOOK_SECRET'] = 'very-secret';
    const env = buildSandboxEnv(true);
    expect(env['WEBHOOK_SECRET']).toBeUndefined();
    delete process.env['WEBHOOK_SECRET'];
  });

  it('never includes GITHUB_APP_PRIVATE_KEY (secret isolation, ENGN-05)', () => {
    process.env['GITHUB_APP_PRIVATE_KEY'] = '-----BEGIN RSA PRIVATE KEY-----';
    const env = buildSandboxEnv(true);
    expect(env['GITHUB_APP_PRIVATE_KEY']).toBeUndefined();
    delete process.env['GITHUB_APP_PRIVATE_KEY'];
  });
});
