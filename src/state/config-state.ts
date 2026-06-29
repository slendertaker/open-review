/**
 * Prepared-statement module for the settings and secrets tables (D2-01, DCFG-01, DCFG-02).
 *
 * Follows the initX prepared-statement pattern from deliveries.ts and reviews.ts.
 * initConfig(db) must be called once (by openDb) before any getter or setter is used.
 *
 * settings table: plaintext KV pairs (non-secret config).
 * secrets table: AES-256-GCM encrypted values (see src/config/crypto.ts for record format).
 */

import type Database from 'better-sqlite3';

type Statement = Database.Statement<unknown[]>;

let stmtGetSetting: Statement | null = null;
let stmtSetSetting: Statement | null = null;
let stmtGetSecret: Statement | null = null;
let stmtSetSecret: Statement | null = null;
let stmtDeleteSecret: Statement | null = null;
let stmtListSecrets: Statement | null = null;
let stmtCountRows: Statement | null = null;

/**
 * Prepare module-level statements against the provided database handle.
 * Must be called once (by openDb) before any exported function in this module.
 */
export function initConfig(db: Database.Database): void {
  stmtGetSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  stmtSetSetting = db.prepare(
    'INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)',
  );
  stmtGetSecret = db.prepare('SELECT encrypted FROM secrets WHERE name = ?');
  stmtSetSecret = db.prepare(
    "INSERT OR REPLACE INTO secrets (name, encrypted, updated_at) VALUES (?, ?, datetime('now'))",
  );
  stmtDeleteSecret = db.prepare('DELETE FROM secrets WHERE name = ?');
  stmtListSecrets = db.prepare('SELECT name FROM secrets ORDER BY name');
  // Count total rows across both settings and secrets to guard seedFromEnvIfEmpty.
  stmtCountRows = db.prepare(
    'SELECT (SELECT COUNT(*) FROM settings) + (SELECT COUNT(*) FROM secrets) AS total',
  );
}

/** Read a setting value by key. Returns undefined if not present. */
export function getSetting(key: string): string | undefined {
  if (!stmtGetSetting) {
    throw new Error('config not initialised -- call openDb() before getSetting()');
  }
  const row = stmtGetSetting.get(key) as { value: string } | undefined;
  return row?.value;
}

/** Write (upsert) a setting value by key. */
export function setSetting(key: string, value: string): void {
  if (!stmtSetSetting) {
    throw new Error('config not initialised -- call openDb() before setSetting()');
  }
  stmtSetSetting.run(key, value);
}

/** Read the raw encrypted record for a secret by name. Returns undefined if not present. */
export function getSecretRecord(name: string): string | undefined {
  if (!stmtGetSecret) {
    throw new Error('config not initialised -- call openDb() before getSecretRecord()');
  }
  const row = stmtGetSecret.get(name) as { encrypted: string } | undefined;
  return row?.encrypted;
}

/** Write (upsert) an encrypted secret record. updated_at is set to SQLite datetime('now'). */
export function setSecretRecord(name: string, encrypted: string): void {
  if (!stmtSetSecret) {
    throw new Error('config not initialised -- call openDb() before setSecretRecord()');
  }
  stmtSetSecret.run(name, encrypted);
}

/** Delete a secret record by name. No-op if not present. */
export function deleteSecretRecord(name: string): void {
  if (!stmtDeleteSecret) {
    throw new Error('config not initialised -- call openDb() before deleteSecretRecord()');
  }
  stmtDeleteSecret.run(name);
}

/** List all secret names in alphabetical order. */
export function listSecretNames(): string[] {
  if (!stmtListSecrets) {
    throw new Error('config not initialised -- call openDb() before listSecretNames()');
  }
  const rows = stmtListSecrets.all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/**
 * Return the total row count across settings + secrets tables.
 * Used by seedFromEnvIfEmpty to detect whether data exists.
 */
export function countConfigRows(): number {
  if (!stmtCountRows) {
    throw new Error('config not initialised -- call openDb() before countConfigRows()');
  }
  const row = stmtCountRows.get() as { total: number };
  return row.total;
}
