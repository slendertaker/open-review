/**
 * repo_settings table: per-repo enable state and severity/ignore-globs overrides.
 *
 * Tests initRepoSettings, getRepoSettings, upsertRepoSettings, listEnabledFullNames,
 * and countRepoSettings from src/state/repo-settings.ts using in-memory SQLite.
 *
 * All imports use .js extension per NodeNext ESM resolution.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initRepoSettings,
  getRepoSettings,
  upsertRepoSettings,
  listEnabledFullNames,
  listAllRepoSettings,
  countRepoSettings,
} from '../../src/state/repo-settings.js';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS repo_settings (
    full_name    TEXT PRIMARY KEY,
    enabled      INTEGER NOT NULL DEFAULT 0,
    min_severity TEXT,
    ignore_globs TEXT,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  initRepoSettings(db);
  return db;
}

describe('repo-settings state module', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('getRepoSettings returns null when no row exists', () => {
    expect(getRepoSettings('owner/repo')).toBeNull();
  });

  it('countRepoSettings is 0 on an empty table', () => {
    expect(countRepoSettings()).toBe(0);
  });

  it('upsertRepoSettings creates a row with enabled=true and null overrides by default', () => {
    upsertRepoSettings('owner/repo', { enabled: true });
    const row = getRepoSettings('owner/repo');
    expect(row).toEqual({
      fullName: 'owner/repo',
      enabled: true,
      minSeverity: null,
      ignoreGlobs: null,
    });
  });

  it('upsertRepoSettings persists a minSeverity and ignoreGlobs override', () => {
    upsertRepoSettings('owner/repo', {
      enabled: true,
      minSeverity: 'critical',
      ignoreGlobs: ['dist/**', 'build/**'],
    });
    const row = getRepoSettings('owner/repo');
    expect(row?.minSeverity).toBe('critical');
    expect(row?.ignoreGlobs).toEqual(['dist/**', 'build/**']);
  });

  it('a partial patch (enabled only) does not clobber an existing override', () => {
    upsertRepoSettings('owner/repo', { enabled: true, minSeverity: 'high', ignoreGlobs: ['a/**'] });

    // Flip enabled off without touching the overrides.
    upsertRepoSettings('owner/repo', { enabled: false });

    const row = getRepoSettings('owner/repo');
    expect(row?.enabled).toBe(false);
    expect(row?.minSeverity).toBe('high');
    expect(row?.ignoreGlobs).toEqual(['a/**']);
  });

  it('passing minSeverity: null explicitly clears a previously-set override', () => {
    upsertRepoSettings('owner/repo', { enabled: true, minSeverity: 'high' });
    upsertRepoSettings('owner/repo', { minSeverity: null });

    const row = getRepoSettings('owner/repo');
    expect(row?.minSeverity).toBeNull();
    // enabled is preserved from the prior upsert.
    expect(row?.enabled).toBe(true);
  });

  it('listEnabledFullNames returns only enabled repos, in insertion order', () => {
    upsertRepoSettings('owner/repo-a', { enabled: true });
    upsertRepoSettings('owner/repo-b', { enabled: false });
    upsertRepoSettings('owner/repo-c', { enabled: true });

    expect(listEnabledFullNames()).toEqual(['owner/repo-a', 'owner/repo-c']);
  });

  it('listAllRepoSettings returns every row regardless of enabled state, ordered by full_name', () => {
    upsertRepoSettings('owner/zeta', { enabled: true });
    upsertRepoSettings('owner/alpha', { enabled: false });

    const all = listAllRepoSettings();
    expect(all.map((r) => r.fullName)).toEqual(['owner/alpha', 'owner/zeta']);
  });

  it('countRepoSettings reflects the number of rows after upserts', () => {
    upsertRepoSettings('owner/repo-a', { enabled: true });
    upsertRepoSettings('owner/repo-b', { enabled: true });
    expect(countRepoSettings()).toBe(2);
  });
});
