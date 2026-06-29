/**
 * BRND-02: Em-dash guard over user-facing surfaces.
 *
 * Scans an allowlist of user-facing surfaces for the em-dash character U+2014
 * and fails with the offending file paths if any is found.
 *
 * Allowlist (D4-08 scope, not denylist): views/**\/\*.eta, README.md,
 * docs/**\/\*.md, src/poster/post.ts, src/worker/prompt.ts.
 * Code comments and .planning/ are exempt by construction (not in the list).
 *
 * A non-existent allowlisted path is skipped, not an error -- the guard
 * must not require a surface to exist.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, globSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Reference the em-dash via its Unicode escape, NOT a literal glyph,
// so this test file itself cannot trigger its own guard if the scope widens.
const EM_DASH = '\u2014';

const SURFACES = [
  'views/**/*.eta',
  'README.md',
  'docs/**/*.md',
  'src/poster/post.ts',
  'src/worker/prompt.ts',
];

/**
 * Fallback recursive walk for glob patterns when fs.globSync is unavailable.
 * Returns all files under `dir` whose relative path matches the pattern's
 * extension filter (crude but sufficient for the two patterns used here).
 */
function walkDir(dir: string, matchExt: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      results.push(...walkDir(full, matchExt));
    } else if (entry.endsWith(matchExt)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Resolve a glob pattern against the repo root (process.cwd()).
 * Uses fs.globSync when available; falls back to a manual recursive walk
 * for the two double-star patterns in SURFACES (RESEARCH A4 fallback).
 * Returns only paths that exist.
 */
function resolvePattern(pattern: string): string[] {
  try {
    // fs.globSync is available on Node 22+ (experimental) and Node 24+.
    const files = globSync(pattern, { cwd: process.cwd() });
    // globSync returns relative paths; convert to absolute for readFileSync.
    return files.map((f) => path.resolve(process.cwd(), f));
  } catch {
    // Fallback: manual walk for double-star patterns.
    if (pattern.includes('**')) {
      const [base, , ext] = pattern.split('/');
      const dir = path.resolve(process.cwd(), base ?? '.');
      const matchExt = ext?.startsWith('*') ? ext.slice(1) : '';
      return walkDir(dir, matchExt);
    }
    // Single file pattern -- just resolve and let the caller check existence.
    return [path.resolve(process.cwd(), pattern)];
  }
}

describe('BRND-02 no em-dashes in user-facing text', () => {
  it('contains no U+2014 in scoped surfaces', () => {
    const offenders: string[] = [];

    for (const pattern of SURFACES) {
      const files = resolvePattern(pattern);
      for (const file of files) {
        let content: string;
        try {
          content = readFileSync(file, 'utf8');
        } catch {
          // File does not exist -- skip it (non-existent paths are not errors).
          continue;
        }
        if (content.includes(EM_DASH)) {
          offenders.push(file);
        }
      }
    }

    expect(
      offenders,
      `em-dash (U+2014) found in: ${offenders.join(', ')}`,
    ).toEqual([]);
  });
});
