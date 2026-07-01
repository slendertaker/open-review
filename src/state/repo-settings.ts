/**
 * repo_settings table: per-repo enable state and optional global-default
 * overrides (min severity, ignore globs).
 *
 * initRepoSettings must be called once (by openDb) before any other function.
 * All functions are synchronous (better-sqlite3 is synchronous).
 */

import type Database from 'better-sqlite3';

type Statement = Database.Statement<unknown[]>;

export interface RepoSettingsRow {
  fullName: string;
  enabled: boolean;
  minSeverity: string | null;
  ignoreGlobs: string[] | null;
}

interface RawRow {
  full_name: string;
  enabled: number;
  min_severity: string | null;
  ignore_globs: string | null;
}

let stmtGet: Statement | null = null;
let stmtUpsert: Statement | null = null;
let stmtListEnabled: Statement | null = null;
let stmtListAll: Statement | null = null;
let stmtCount: Statement | null = null;

/**
 * Prepare module-level statements against the provided database handle.
 * Must be called once (by openDb) before any exported function in this module.
 */
export function initRepoSettings(db: Database.Database): void {
  stmtGet = db.prepare('SELECT full_name, enabled, min_severity, ignore_globs FROM repo_settings WHERE full_name = ?');
  stmtUpsert = db.prepare(
    `INSERT INTO repo_settings (full_name, enabled, min_severity, ignore_globs, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(full_name) DO UPDATE SET enabled = excluded.enabled,
                                           min_severity = excluded.min_severity,
                                           ignore_globs = excluded.ignore_globs,
                                           updated_at = excluded.updated_at`,
  );
  stmtListEnabled = db.prepare('SELECT full_name FROM repo_settings WHERE enabled = 1');
  stmtListAll = db.prepare('SELECT full_name, enabled, min_severity, ignore_globs FROM repo_settings ORDER BY full_name');
  stmtCount = db.prepare('SELECT COUNT(*) AS total FROM repo_settings');
}

function toRow(raw: RawRow): RepoSettingsRow {
  let ignoreGlobs: string[] | null = null;
  if (raw.ignore_globs) {
    try {
      ignoreGlobs = JSON.parse(raw.ignore_globs) as string[];
    } catch {
      ignoreGlobs = null;
    }
  }
  return {
    fullName: raw.full_name,
    enabled: raw.enabled === 1,
    minSeverity: raw.min_severity,
    ignoreGlobs,
  };
}

/** Read a single repo's settings row. Returns null if the repo has no row yet. */
export function getRepoSettings(fullName: string): RepoSettingsRow | null {
  if (!stmtGet) throw new Error('repo-settings not initialised -- call openDb() first');
  const row = stmtGet.get(fullName) as RawRow | undefined;
  return row ? toRow(row) : null;
}

/**
 * Upsert a repo's settings row. Merges with the existing row (if any) so a
 * partial patch (e.g. only `enabled`) does not clobber other fields.
 */
export function upsertRepoSettings(
  fullName: string,
  patch: Partial<Pick<RepoSettingsRow, 'enabled' | 'minSeverity' | 'ignoreGlobs'>>,
): void {
  if (!stmtUpsert) throw new Error('repo-settings not initialised -- call openDb() first');
  const current = getRepoSettings(fullName);
  const enabled = patch.enabled ?? current?.enabled ?? false;
  const minSeverity = 'minSeverity' in patch ? patch.minSeverity ?? null : current?.minSeverity ?? null;
  const ignoreGlobs = 'ignoreGlobs' in patch ? patch.ignoreGlobs ?? null : current?.ignoreGlobs ?? null;
  stmtUpsert.run(
    fullName,
    enabled ? 1 : 0,
    minSeverity,
    ignoreGlobs ? JSON.stringify(ignoreGlobs) : null,
  );
}

/** Full names of repos with enabled=1, in insertion order. */
export function listEnabledFullNames(): string[] {
  if (!stmtListEnabled) throw new Error('repo-settings not initialised -- call openDb() first');
  const rows = stmtListEnabled.all() as Array<{ full_name: string }>;
  return rows.map((r) => r.full_name);
}

/** All repo settings rows, ordered by full_name. */
export function listAllRepoSettings(): RepoSettingsRow[] {
  if (!stmtListAll) throw new Error('repo-settings not initialised -- call openDb() first');
  const rows = stmtListAll.all() as RawRow[];
  return rows.map(toRow);
}

/** Total row count -- used to guard the one-time backfill from the legacy `repos` setting. */
export function countRepoSettings(): number {
  if (!stmtCount) throw new Error('repo-settings not initialised -- call openDb() first');
  const row = stmtCount.get() as { total: number };
  return row.total;
}
