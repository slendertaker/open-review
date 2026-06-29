/**
 * Database lifecycle: open, WAL, schema, init statements.
 *
 * schema.sql is resolved relative to THIS file via import.meta.url + fileURLToPath
 * so it works correctly under systemd (cwd = /) as well as in dev (cwd = project root).
 */

import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDeliveries } from './deliveries.js';
import { initReviews } from './reviews.js';
import { initConfig } from './config-state.js';
import { initReviewRuns } from './review-runs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Open (or create) a better-sqlite3 database at dbPath, enable WAL mode,
 * apply the schema idempotently, and initialise prepared statements.
 */
export function openDb(dbPath: string): Database.Database {
  if (dbPath !== ':memory:' && !dbPath.startsWith(':')) {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf8');
  db.exec(schema);

  initDeliveries(db);
  initReviews(db);
  initConfig(db);
  initReviewRuns(db);

  return db;
}
