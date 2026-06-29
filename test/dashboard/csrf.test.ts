/**
 * Dashboard CSRF protection tests (DSEC-03) -- Plan 02.
 *
 * Verifies that a state-changing POST without a valid _csrf token is rejected
 * (403) and the same POST with a valid token passes the CSRF gate.
 * POST /login is the canonical CSRF-protected mutation in this plan.
 */

import argon2 from 'argon2';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/state/db.js';
import { buildServer } from '../../src/server.js';
import { SqliteConfigStore } from '../../src/config/sqlite-store.js';
import { setSetting } from '../../src/state/config-state.js';
import { lockoutMap } from '../../src/dashboard/auth.js';

const PASSWORD = 'correct-horse-battery';

function makeKey(): Buffer {
  return Buffer.alloc(32, 0x42);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cookieHeader(res: any): string {
  const raw = res.headers['set-cookie'] as string | string[] | undefined;
  if (!raw) return '';
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((c) => c.split(';')[0]).join('; ');
}

function extractCsrf(html: string): string {
  const m = /name="_csrf"[^>]*value="([^"]+)"/.exec(html);
  return m ? m[1]! : '';
}

describe('dashboard CSRF protection (DSEC-03) -- Plan 02', () => {
  let db: Database.Database;
  let store: SqliteConfigStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

  beforeEach(async () => {
    db = openDb(':memory:');
    store = new SqliteConfigStore(db, makeKey());
    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    setSetting('password_hash', passwordHash);
    server = await buildServer(store, db, () => {});
    lockoutMap.clear();
  });

  afterEach(async () => {
    await server.close();
    db.close();
    lockoutMap.clear();
  });

  it('POST to a mutating route without _csrf token returns 403', async () => {
    // Establish a session via GET /login (so a session secret exists).
    const getRes = await server.inject({ method: 'GET', url: '/login' });
    const cookie = cookieHeader(getRes);

    const res = await server.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      // No _csrf field.
      payload: `password=${encodeURIComponent(PASSWORD)}`,
    });

    expect(res.statusCode).toBe(403);
  });

  it('POST to a mutating route with a valid _csrf token succeeds (passes CSRF gate)', async () => {
    const getRes = await server.inject({ method: 'GET', url: '/login' });
    const cookie = cookieHeader(getRes);
    const csrf = extractCsrf(getRes.body as string);
    expect(csrf).toBeTruthy();

    const res = await server.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `password=${encodeURIComponent(PASSWORD)}&_csrf=${encodeURIComponent(csrf)}`,
    });

    // CSRF gate passed -> handler ran -> 302 redirect (not 403).
    expect(res.statusCode).not.toBe(403);
    expect(res.statusCode).toBe(302);
  });
});
