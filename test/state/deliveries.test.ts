/**
 * Delivery dedup tests (INTK-04, D-13)
 *
 * Tests recordDelivery (INSERT OR IGNORE, isNew flag) and
 * pruneOldDeliveries (7-day TTL) from src/state/deliveries.ts.
 *
 * All imports use .js extension per NodeNext ESM resolution.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initDeliveries,
  recordDelivery,
  pruneOldDeliveries,
} from '../../src/state/deliveries.js';

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_id TEXT NOT NULL UNIQUE,
    received_at TEXT NOT NULL
  );
`;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  return db;
}

describe('state/deliveries (INTK-04, D-13)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
    initDeliveries(db);
  });

  // INTK-04: duplicate delivery detection
  describe('delivery dedup (INTK-04)', () => {
    it('first delivery for an id returns isNew=true', () => {
      const result = recordDelivery('guid-aaa');
      expect(result.isNew).toBe(true);
    });

    it('second delivery with the same id returns isNew=false', () => {
      recordDelivery('guid-bbb');
      const result = recordDelivery('guid-bbb');
      expect(result.isNew).toBe(false);
    });

    it('different delivery ids are each treated as new', () => {
      expect(recordDelivery('guid-1').isNew).toBe(true);
      expect(recordDelivery('guid-2').isNew).toBe(true);
      expect(recordDelivery('guid-3').isNew).toBe(true);
    });

    it('duplicate does not insert an extra row', () => {
      recordDelivery('guid-ccc');
      recordDelivery('guid-ccc');
      const rows = db
        .prepare("SELECT COUNT(*) as cnt FROM webhook_deliveries WHERE delivery_id = 'guid-ccc'")
        .get() as { cnt: number };
      expect(rows.cnt).toBe(1);
    });
  });

  // D-13: 7-day TTL prune
  describe('TTL prune (D-13)', () => {
    it('pruneOldDeliveries removes rows older than 7 days', () => {
      // Insert an old row directly with a past timestamp
      db.prepare(
        "INSERT INTO webhook_deliveries (delivery_id, received_at) VALUES (?, datetime('now', '-8 days'))",
      ).run('guid-old');

      // Insert a recent row
      recordDelivery('guid-new');

      pruneOldDeliveries();

      const oldRow = db
        .prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = 'guid-old'")
        .all() as unknown[];
      expect(oldRow).toHaveLength(0);

      const newRow = db
        .prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = 'guid-new'")
        .all() as unknown[];
      expect(newRow).toHaveLength(1);
    });

    it('pruneOldDeliveries leaves rows within the 7-day window', () => {
      db.prepare(
        "INSERT INTO webhook_deliveries (delivery_id, received_at) VALUES (?, datetime('now', '-6 days'))",
      ).run('guid-recent');

      pruneOldDeliveries();

      const rows = db
        .prepare("SELECT * FROM webhook_deliveries WHERE delivery_id = 'guid-recent'")
        .all() as unknown[];
      expect(rows).toHaveLength(1);
    });

    it('pruneOldDeliveries with empty table does not throw', () => {
      expect(() => pruneOldDeliveries()).not.toThrow();
    });
  });
});
