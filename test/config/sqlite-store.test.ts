/**
 * SqliteConfigStore + seedFromEnvIfEmpty tests (DCFG-01, DCFG-05).
 *
 * Tests live getter behavior (no boot snapshot), empty-table defaults,
 * round-trip for secret values via encrypted storage, and the one-way
 * seed-from-env guard (Pitfall 4: must be idempotent).
 *
 * All imports use .js extension per NodeNext ESM resolution.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteConfigStore, seedFromEnvIfEmpty } from '../../src/config/sqlite-store.js';
import { initConfig, setSetting, setSecretRecord } from '../../src/state/config-state.js';
import { initRepoSettings, upsertRepoSettings } from '../../src/state/repo-settings.js';
import { DEFAULT_IGNORE_GLOBS } from '../../src/config/store.js';
import { encryptSecret } from '../../src/config/crypto.js';

/** Minimal schema for config-state tests */
const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS secrets (
    name       TEXT PRIMARY KEY,
    encrypted  TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS repo_settings (
    full_name    TEXT PRIMARY KEY,
    enabled      INTEGER NOT NULL DEFAULT 0,
    min_severity TEXT,
    ignore_globs TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

const TEST_KEY = Buffer.alloc(32, 0x01);

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  initRepoSettings(db);
  return db;
}

/** Save + restore env around a block */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = vars[k];
    }
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('SqliteConfigStore -- defaults on empty tables (DCFG-01)', () => {
  let db: Database.Database;
  let store: SqliteConfigStore;

  beforeEach(() => {
    db = createTestDb();
    initConfig(db);
    store = new SqliteConfigStore(db, TEST_KEY);
  });

  afterEach(() => {
    db.close();
  });

  it('minSeverity defaults to "medium" when no row in settings', () => {
    expect(store.minSeverity).toBe('medium');
  });

  it('ignoreGlobs defaults to DEFAULT_IGNORE_GLOBS when no row in settings', () => {
    expect(store.ignoreGlobs).toEqual(DEFAULT_IGNORE_GLOBS);
  });

  it('skipDrafts defaults to true when no row in settings', () => {
    expect(store.skipDrafts).toBe(true);
  });

  it('skipForks defaults to true when no row in settings', () => {
    expect(store.skipForks).toBe(true);
  });

  it('repos defaults to empty array when no row in settings', () => {
    expect(store.repos).toEqual([]);
  });

  it('webhookSecret defaults to empty string when no row in settings', () => {
    expect(store.webhookSecret).toBe('');
  });
});

describe('SqliteConfigStore -- live getter propagation (DCFG-05)', () => {
  let db: Database.Database;
  let store: SqliteConfigStore;

  beforeEach(() => {
    db = createTestDb();
    initConfig(db);
    store = new SqliteConfigStore(db, TEST_KEY);
  });

  afterEach(() => {
    db.close();
  });

  it('setSetting updates minSeverity without reconstructing the store (live getter)', () => {
    expect(store.minSeverity).toBe('medium');
    setSetting('min_severity', 'high');
    expect(store.minSeverity).toBe('high');
  });

  it('setSetting updates webhookSecret live (DCFG-05 live propagation)', () => {
    setSetting('webhook_secret', 'first-secret');
    expect(store.webhookSecret).toBe('first-secret');
    setSetting('webhook_secret', 'updated-secret');
    expect(store.webhookSecret).toBe('updated-secret');
  });

  it('repos reflects enabled rows in the repo_settings table', () => {
    upsertRepoSettings('owner/repo1', { enabled: true });
    upsertRepoSettings('owner/repo2', { enabled: true });
    expect(store.repos).toEqual(['owner/repo1', 'owner/repo2']);
  });
});

describe('SqliteConfigStore -- secret storage (DCFG-02, DCFG-01)', () => {
  let db: Database.Database;
  let store: SqliteConfigStore;

  beforeEach(() => {
    db = createTestDb();
    initConfig(db);
    store = new SqliteConfigStore(db, TEST_KEY);
  });

  afterEach(() => {
    db.close();
  });

  it('claudeOauthToken decrypts to the stored value', () => {
    const encrypted = encryptSecret('my-oauth-token-value', TEST_KEY);
    setSecretRecord('claude_oauth_token', encrypted);
    expect(store.claudeOauthToken).toBe('my-oauth-token-value');
  });

  it('claudeOauthToken returns undefined when no record exists', () => {
    expect(store.claudeOauthToken).toBeUndefined();
  });

  it('anthropicApiKey decrypts to the stored value', () => {
    const encrypted = encryptSecret('sk-ant-api03-test', TEST_KEY);
    setSecretRecord('anthropic_api_key', encrypted);
    expect(store.anthropicApiKey).toBe('sk-ant-api03-test');
  });

});

describe('seedFromEnvIfEmpty -- one-way bootstrap guard (DCFG-01, Pitfall 4)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    initConfig(db);
  });

  afterEach(() => {
    db.close();
  });

  it('seeds minSeverity from env when tables are empty', () => {
    withEnv(
      {
        OPEN_REVIEW_WEBHOOK_SECRET: 'seed-secret',
        OPEN_REVIEW_MIN_SEVERITY: 'high',
        OPEN_REVIEW_REPOS: undefined,
        OPEN_REVIEW_SKIP_DRAFTS: undefined,
        OPEN_REVIEW_SKIP_FORKS: undefined,
        OPEN_REVIEW_IGNORE_GLOBS: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        ANTHROPIC_API_KEY: undefined,
        GITHUB_TOKEN: undefined,
        GITHUB_APP_ID: undefined,
        GITHUB_APP_PRIVATE_KEY: undefined,
        GITHUB_APP_PRIVATE_KEY_PATH: undefined,
        WEBHOOK_SECRET: undefined,
      },
      () => {
        seedFromEnvIfEmpty(db, TEST_KEY);
        const store = new SqliteConfigStore(db, TEST_KEY);
        expect(store.minSeverity).toBe('high');
        expect(store.webhookSecret).toBe('seed-secret');
      },
    );
  });

  it('calling seedFromEnvIfEmpty again after data exists makes zero row changes (idempotent)', () => {
    withEnv(
      {
        OPEN_REVIEW_WEBHOOK_SECRET: 'first-seed',
        OPEN_REVIEW_MIN_SEVERITY: 'low',
        OPEN_REVIEW_REPOS: undefined,
        OPEN_REVIEW_SKIP_DRAFTS: undefined,
        OPEN_REVIEW_SKIP_FORKS: undefined,
        OPEN_REVIEW_IGNORE_GLOBS: undefined,
        CLAUDE_CODE_OAUTH_TOKEN: undefined,
        ANTHROPIC_API_KEY: undefined,
        GITHUB_TOKEN: undefined,
        GITHUB_APP_ID: undefined,
        GITHUB_APP_PRIVATE_KEY: undefined,
        GITHUB_APP_PRIVATE_KEY_PATH: undefined,
        WEBHOOK_SECRET: undefined,
      },
      () => {
        seedFromEnvIfEmpty(db, TEST_KEY);
        // Manually change a value in the DB to simulate operator edit
        setSetting('webhook_secret', 'operator-changed-secret');

        // Second seed call with different env value -- must be a no-op
        withEnv({ OPEN_REVIEW_WEBHOOK_SECRET: 'second-seed' }, () => {
          seedFromEnvIfEmpty(db, TEST_KEY);
        });

        const store = new SqliteConfigStore(db, TEST_KEY);
        // Still the operator's value, not 'second-seed'
        expect(store.webhookSecret).toBe('operator-changed-secret');
      },
    );
  });
});
