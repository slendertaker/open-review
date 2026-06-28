/**
 * webhook_deliveries table: dedup and TTL prune (D-13, INTK-01).
 *
 * INSERT OR IGNORE on delivery_id ensures no TOCTOU race.
 * Prune deletes rows older than 7 days on startup and periodically.
 */

import type Database from 'better-sqlite3';

type Statement = Database.Statement<unknown[]>;

let insertDelivery: Statement | null = null;
let pruneStmt: Statement | null = null;

/**
 * Prepare module-level statements against the provided database handle.
 * Must be called once (by openDb) before recordDelivery or pruneOldDeliveries.
 */
export function initDeliveries(db: Database.Database): void {
  insertDelivery = db.prepare(
    'INSERT OR IGNORE INTO webhook_deliveries (delivery_id, received_at) VALUES (?, ?)',
  );
  // Normalize both sides through datetime() to avoid string-comparison issues.
  pruneStmt = db.prepare(
    "DELETE FROM webhook_deliveries WHERE datetime(received_at) < datetime('now', '-7 days')",
  );
}

/**
 * Atomically record a delivery GUID using INSERT OR IGNORE.
 * Returns { isNew: true } on first insertion, { isNew: false } on duplicate.
 */
export function recordDelivery(deliveryId: string): { isNew: boolean } {
  if (!insertDelivery) {
    throw new Error('deliveries not initialised -- call openDb() before recordDelivery()');
  }
  const info = insertDelivery.run(deliveryId, new Date().toISOString());
  return { isNew: info.changes === 1 };
}

/**
 * Delete delivery rows older than 7 days.
 * Call on startup and periodically (e.g. every 24 h) to keep the table bounded.
 */
export function pruneOldDeliveries(): void {
  if (!pruneStmt) {
    throw new Error('deliveries not initialised -- call openDb() before pruneOldDeliveries()');
  }
  pruneStmt.run();
}
