/**
 * Config store tests: severity floor default + ignore globs default (NOISE-01, NOISE-04).
 *
 * Requirements: NOISE-01 (severity floor), NOISE-04 (default ignore globs)
 *
 * D-14: default minSeverity suppresses the lowest tier (i.e., defaults to 'medium').
 * D-18: ConfigStore interface exposes ignoreGlobs defaulting to DEFAULT_IGNORE_GLOBS.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EnvConfigStore, DEFAULT_IGNORE_GLOBS } from '../../src/config/store.js';

/** Save + restore env around each test */
function withEnv(vars: Record<string, string>, fn: () => void): () => void {
  return () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of Object.keys(vars)) {
      saved[k] = process.env[k];
      process.env[k] = vars[k];
    }
    try {
      fn();
    } finally {
      for (const k of Object.keys(vars)) {
        if (saved[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = saved[k];
        }
      }
    }
  };
}

const BASE_ENV = {
  OPEN_REVIEW_WEBHOOK_SECRET: 'test-secret',
};

describe('EnvConfigStore -- severity floor (NOISE-01, D-14)', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Save any relevant env vars and set required secret.
    const toSave = [
      'OPEN_REVIEW_WEBHOOK_SECRET', 'WEBHOOK_SECRET',
      'OPEN_REVIEW_MIN_SEVERITY',
    ];
    savedEnv = {};
    for (const k of toSave) savedEnv[k] = process.env[k];
    process.env['OPEN_REVIEW_WEBHOOK_SECRET'] = 'test-secret';
    delete process.env['WEBHOOK_SECRET'];
    delete process.env['OPEN_REVIEW_MIN_SEVERITY'];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults minSeverity to medium (D-14: default suppresses the lowest tier)', () => {
    const store = new EnvConfigStore();
    expect(store.minSeverity).toBe('medium');
  });

  it('accepts minSeverity=low from env (below-default explicit opt-in)', () => {
    process.env['OPEN_REVIEW_MIN_SEVERITY'] = 'low';
    const store = new EnvConfigStore();
    expect(store.minSeverity).toBe('low');
  });

  it('accepts minSeverity=high from env', () => {
    process.env['OPEN_REVIEW_MIN_SEVERITY'] = 'high';
    const store = new EnvConfigStore();
    expect(store.minSeverity).toBe('high');
  });

  it('accepts minSeverity=critical from env', () => {
    process.env['OPEN_REVIEW_MIN_SEVERITY'] = 'critical';
    const store = new EnvConfigStore();
    expect(store.minSeverity).toBe('critical');
  });

  it('throws on invalid minSeverity value (fail-fast zod validation)', () => {
    process.env['OPEN_REVIEW_MIN_SEVERITY'] = 'extreme';
    expect(() => new EnvConfigStore()).toThrow(/extreme/);
  });
});

describe('EnvConfigStore -- ignore globs (NOISE-04, D-14)', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    const toSave = [
      'OPEN_REVIEW_WEBHOOK_SECRET', 'WEBHOOK_SECRET',
      'OPEN_REVIEW_IGNORE_GLOBS',
    ];
    savedEnv = {};
    for (const k of toSave) savedEnv[k] = process.env[k];
    process.env['OPEN_REVIEW_WEBHOOK_SECRET'] = 'test-secret';
    delete process.env['WEBHOOK_SECRET'];
    delete process.env['OPEN_REVIEW_IGNORE_GLOBS'];
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('defaults ignoreGlobs to DEFAULT_IGNORE_GLOBS when env var is not set', () => {
    const store = new EnvConfigStore();
    expect(store.ignoreGlobs).toEqual(DEFAULT_IGNORE_GLOBS);
  });

  it('DEFAULT_IGNORE_GLOBS includes lockfile patterns with **/ prefix (NOISE-04)', () => {
    const lockfileGlobs = [
      '**/package-lock.json',
      '**/yarn.lock',
      '**/pnpm-lock.yaml',
      '**/Cargo.lock',
      '**/poetry.lock',
      '**/go.sum',
      '**/*.lock',
    ];
    for (const glob of lockfileGlobs) {
      expect(DEFAULT_IGNORE_GLOBS).toContain(glob);
    }
  });

  it('DEFAULT_IGNORE_GLOBS includes vendored/generated path patterns (NOISE-04)', () => {
    const vendorGlobs = ['node_modules/**', 'vendor/**', 'third_party/**'];
    const buildGlobs = ['dist/**', 'build/**', '**/*.min.js', '**/*.map'];
    for (const glob of [...vendorGlobs, ...buildGlobs]) {
      expect(DEFAULT_IGNORE_GLOBS).toContain(glob);
    }
  });

  it('accepts custom ignoreGlobs from OPEN_REVIEW_IGNORE_GLOBS env var', () => {
    process.env['OPEN_REVIEW_IGNORE_GLOBS'] = '**/custom.lock,dist/**';
    const store = new EnvConfigStore();
    expect(store.ignoreGlobs).toEqual(['**/custom.lock', 'dist/**']);
  });
});
