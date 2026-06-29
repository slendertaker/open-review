/**
 * SqliteSessionStore tests (DSEC-03, D2-06, D2-07).
 *
 * Tests the @fastify/session-compatible custom store: set/get round-trip,
 * expiry filtering, destroy, prune, and the pino scrub extension for
 * OAuth tokens and session cookie shapes.
 *
 * All imports use .js extension per NodeNext ESM resolution.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteSessionStore } from '../../src/state/sessions.js';
import { scrub } from '../../src/logger.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  return db;
}

type SessionData = Record<string, unknown>;
type StoreCallback = (err: Error | null, session?: unknown) => void;

/** Promisify a store callback for cleaner test assertions */
function callGet(store: SqliteSessionStore, id: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    store.get(id, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function callSet(store: SqliteSessionStore, id: string, session: SessionData): Promise<void> {
  return new Promise((resolve, reject) => {
    store.set(id, session, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function callDestroy(store: SqliteSessionStore, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    store.destroy(id, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

describe('SqliteSessionStore -- set/get round-trip (DSEC-03)', () => {
  let db: Database.Database;
  let store: SqliteSessionStore;

  beforeEach(() => {
    db = createTestDb();
    store = new SqliteSessionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('set then get returns the same session object (JSON round-trip)', async () => {
    const session: SessionData = {
      authenticated: true,
      userId: 'operator',
      cookie: { maxAge: 86400000 },
    };
    await callSet(store, 'sess-001', session);
    const retrieved = await callGet(store, 'sess-001');
    expect(retrieved).toEqual(session);
  });

  it('get for unknown id returns undefined via callback', async () => {
    const result = await callGet(store, 'does-not-exist');
    expect(result).toBeUndefined();
  });

  it('get for expired session returns undefined via callback', async () => {
    // Use a maxAge of 1ms to expire immediately
    const session: SessionData = { authenticated: true, cookie: { maxAge: 1 } };
    await callSet(store, 'sess-expired', session);
    // Wait briefly to ensure expiry
    await new Promise((r) => setTimeout(r, 5));
    // SQLite datetime comparison is second-granularity so we manipulate directly
    db.prepare(
      "UPDATE sessions SET expires_at = datetime('now', '-1 second') WHERE id = ?",
    ).run('sess-expired');
    const result = await callGet(store, 'sess-expired');
    expect(result).toBeUndefined();
  });
});

describe('SqliteSessionStore -- destroy (DSEC-03)', () => {
  let db: Database.Database;
  let store: SqliteSessionStore;

  beforeEach(() => {
    db = createTestDb();
    store = new SqliteSessionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('destroy removes the row; subsequent get returns undefined', async () => {
    const session: SessionData = { authenticated: true, cookie: { maxAge: 86400000 } };
    await callSet(store, 'sess-del', session);
    expect(await callGet(store, 'sess-del')).toEqual(session);

    await callDestroy(store, 'sess-del');
    expect(await callGet(store, 'sess-del')).toBeUndefined();
  });
});

describe('SqliteSessionStore -- prune (DSEC-03)', () => {
  let db: Database.Database;
  let store: SqliteSessionStore;

  beforeEach(() => {
    db = createTestDb();
    store = new SqliteSessionStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('prune deletes only expired rows and leaves active rows intact', async () => {
    const active: SessionData = { authenticated: true, cookie: { maxAge: 86400000 } };
    await callSet(store, 'sess-active', active);
    await callSet(store, 'sess-stale', active);

    // Force stale session to be expired
    db.prepare(
      "UPDATE sessions SET expires_at = datetime('now', '-1 second') WHERE id = ?",
    ).run('sess-stale');

    store.prune();

    expect(await callGet(store, 'sess-active')).toEqual(active);
    expect(await callGet(store, 'sess-stale')).toBeUndefined();
  });
});

describe('pino scrub extension (D2-06, T-02-04)', () => {
  it('scrub redacts a Claude OAuth-shaped token (oauth_token= form)', () => {
    const msg = 'Request sent with oauth_token=sk-ant-oauth03-supersecret123';
    expect(scrub(msg)).not.toContain('supersecret123');
    expect(scrub(msg)).toContain('[REDACTED]');
  });

  it('scrub redacts a GitHub PAT (github_pat_ prefix)', () => {
    const msg = 'Using github_pat_11ABCD_secretvalue for auth';
    expect(scrub(msg)).not.toContain('secretvalue');
    expect(scrub(msg)).toContain('[REDACTED]');
  });

  it('scrub still redacts Phase 1 patterns (sk-ant- prefix)', () => {
    const msg = 'API key sk-ant-api03-longkeyvalue logged in output';
    expect(scrub(msg)).not.toContain('longkeyvalue');
    expect(scrub(msg)).toContain('[REDACTED]');
  });
});
