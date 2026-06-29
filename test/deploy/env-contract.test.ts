/**
 * DEPL-03: Env-contract drift guard.
 *
 * Asserts every KEY= line in deploy/open-review.env.tmpl is a member of the
 * set of env-var names the app actually consumes (from src/config/store.ts,
 * src/config/crypto.ts, src/config/sqlite-store.ts). A stray template key
 * that nothing reads is the drift this catches.
 *
 * Direction is one-way: template keys MUST be a subset of consumed names.
 * The reverse is NOT required -- the template legitimately omits optional
 * operator credentials in guided mode.
 *
 * Intentionally RED until Plan 02 creates deploy/open-review.env.tmpl.
 * If the template file is absent this test fails with a clear message.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();
const TEMPLATE_PATH = path.resolve(REPO_ROOT, 'deploy/open-review.env.tmpl');

// ---------------------------------------------------------------------------
// CONSUMED set -- explicit allowlist (floor) from the three source files.
// Listed literally so the act of maintaining this list keeps humans aware
// of the app's env-var contract (PATTERNS.md: "the test is the drift detector").
// ---------------------------------------------------------------------------

const EXPLICIT_CONSUMED = new Set<string>([
  // src/config/store.ts -- EnvConfigStore constructor + header block
  'OPEN_REVIEW_WEBHOOK_SECRET',
  'WEBHOOK_SECRET',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'GITHUB_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  'OPEN_REVIEW_REPOS',
  'OPEN_REVIEW_MIN_SEVERITY',
  'OPEN_REVIEW_SKIP_DRAFTS',
  'OPEN_REVIEW_SKIP_FORKS',
  'OPEN_REVIEW_LOG_LEVEL',
  'OPEN_REVIEW_DB_PATH',
  'OPEN_REVIEW_PORT',
  'OPEN_REVIEW_HOST',
  'OPEN_REVIEW_IGNORE_GLOBS',
  'OPEN_REVIEW_PROVIDER',
  'OPEN_REVIEW_DOMAIN',
  'OPEN_REVIEW_SESSION_SECRET',
  // src/config/crypto.ts -- loadMachineKey env override
  'OPEN_REVIEW_SECRET_KEY',
]);

/**
 * Dynamically scan source files for additional consumed env-var names.
 * Widens the EXPLICIT_CONSUMED floor so legitimately-added consumers
 * do not cause false positives (plan spec: explicit list is the floor;
 * dynamic scan widens it).
 */
function buildDynamicConsumed(): Set<string> {
  const sourceFiles = [
    path.resolve(REPO_ROOT, 'src/config/store.ts'),
    path.resolve(REPO_ROOT, 'src/config/crypto.ts'),
    path.resolve(REPO_ROOT, 'src/config/sqlite-store.ts'),
  ];

  const namePattern = /['"]([A-Z][A-Z0-9_]+)['"]/g;
  const prefixes = ['OPEN_REVIEW_', 'GITHUB_', 'ANTHROPIC_', 'CLAUDE_'];
  const exact = new Set(['WEBHOOK_SECRET']);

  const dynamic = new Set<string>();

  for (const file of sourceFiles) {
    let src: string;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    while ((m = namePattern.exec(src)) !== null) {
      const name = m[1]!;
      if (
        prefixes.some((p) => name.startsWith(p)) ||
        exact.has(name)
      ) {
        dynamic.add(name);
      }
    }
  }

  return dynamic;
}

/**
 * Union of the explicit allowlist and the dynamically-scanned names.
 */
function buildConsumedSet(): Set<string> {
  const consumed = new Set(EXPLICIT_CONSUMED);
  for (const name of buildDynamicConsumed()) {
    consumed.add(name);
  }
  return consumed;
}

/**
 * Parse KEY=value lines from the EnvironmentFile template.
 * Ignores blank lines and lines starting with '#'.
 * Takes the substring before the first '=' as the key.
 * Keeps only keys matching /^[A-Z][A-Z0-9_]+$/.
 */
function parseTemplateKeys(templateContent: string): string[] {
  return templateContent
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .map((line) => {
      const eqIdx = line.indexOf('=');
      return eqIdx >= 0 ? line.slice(0, eqIdx).trim() : '';
    })
    .filter((key) => /^[A-Z][A-Z0-9_]+$/.test(key));
}

describe('DEPL-03 env-contract drift guard', () => {
  it('deploy/open-review.env.tmpl must exist (Plan 02 creates it)', () => {
    expect(
      existsSync(TEMPLATE_PATH),
      'deploy/open-review.env.tmpl not found -- Plan 02 must create it',
    ).toBe(true);
  });

  it('every template key is consumed by the app (no stray keys)', () => {
    if (!existsSync(TEMPLATE_PATH)) {
      // Template absent -- skip the subset check (the prior it() already fails).
      return;
    }

    const templateContent = readFileSync(TEMPLATE_PATH, 'utf8');
    const templateKeys = parseTemplateKeys(templateContent);
    const consumed = buildConsumedSet();
    const stray = templateKeys.filter((k) => !consumed.has(k));

    expect(
      stray,
      `template keys not consumed by the app: ${stray.join(', ')}`,
    ).toEqual([]);
  });
});
