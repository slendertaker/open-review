/**
 * Dashboard auth tests (DSEC-01, DSEC-03) -- Plan 02.
 *
 * Covers login success/failure, session gating, logout, session-id
 * regeneration after login (session fixation), and lockout after repeated
 * failed attempts.
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

/** Extract the sessionId value from a cookie header string. */
function sessionId(cookie: string): string {
  const m = /sessionId=([^;]+)/.exec(cookie);
  return m ? m[1]! : '';
}

describe('dashboard auth (DSEC-01) -- Plan 02', () => {
  let db: Database.Database;
  let store: SqliteConfigStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

  beforeEach(async () => {
    db = openDb(':memory:');
    store = new SqliteConfigStore(db, makeKey());
    // Set a password so the setup gate is satisfied and /login is reachable.
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

  /** Fetch GET /login and return its csrf token + cookie. */
  async function loginPagePrelude(): Promise<{ csrf: string; cookie: string }> {
    const res = await server.inject({ method: 'GET', url: '/login' });
    return { csrf: extractCsrf(res.body as string), cookie: cookieHeader(res) };
  }

  it('correct password creates session and redirects to /dashboard', async () => {
    const { csrf, cookie } = await loginPagePrelude();

    const res = await server.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `password=${encodeURIComponent(PASSWORD)}&_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toMatch(/\/dashboard/);
  });

  it('wrong password does not authenticate and re-renders /login with error', async () => {
    const { csrf, cookie } = await loginPagePrelude();

    const res = await server.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `password=wrong-password&_csrf=${encodeURIComponent(csrf)}`,
    });

    // Redirect back to /login with flash error.
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toMatch(/\/login/);

    // Follow-up GET /login shows the error.
    const postCookie = cookieHeader(res) || cookie;
    const loginRes = await server.inject({
      method: 'GET',
      url: '/login',
      headers: { cookie: postCookie },
    });
    expect(loginRes.body).toContain('Incorrect password');
  });

  it('unauthenticated GET /dashboard redirects to /login', async () => {
    const res = await server.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toMatch(/\/login/);
  });

  it('authenticated GET /dashboard renders the styled dashboard shell (200)', async () => {
    const { csrf, cookie } = await loginPagePrelude();
    const loginRes = await server.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `password=${encodeURIComponent(PASSWORD)}&_csrf=${encodeURIComponent(csrf)}`,
    });
    const authedCookie = cookieHeader(loginRes);

    const res = await server.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { cookie: authedCookie },
    });

    expect(res.statusCode).toBe(200);
    // Shell renders the nav strip wordmark and all five section headers.
    expect(res.body).toContain('Open Review');
    expect(res.body).toContain('Sign out');
    for (const section of ['General', 'Repositories', 'Provider', 'Secrets', 'Access']) {
      expect(res.body).toContain(section);
    }
  });

  it('session id is regenerated after login (session fixation prevention)', async () => {
    const { csrf, cookie } = await loginPagePrelude();
    const preLoginSid = sessionId(cookie);

    const res = await server.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `password=${encodeURIComponent(PASSWORD)}&_csrf=${encodeURIComponent(csrf)}`,
    });

    const postLoginSid = sessionId(cookieHeader(res));
    expect(postLoginSid).toBeTruthy();
    expect(postLoginSid).not.toBe(preLoginSid);
  });

  it('GET /logout destroys session and redirects to /login', async () => {
    const { csrf, cookie } = await loginPagePrelude();
    const loginRes = await server.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `password=${encodeURIComponent(PASSWORD)}&_csrf=${encodeURIComponent(csrf)}`,
    });
    const authedCookie = cookieHeader(loginRes);

    const logoutRes = await server.inject({
      method: 'GET',
      url: '/logout',
      headers: { cookie: authedCookie },
    });
    expect(logoutRes.statusCode).toBe(302);
    expect(logoutRes.headers['location']).toMatch(/\/login/);

    // After logout, /dashboard with the old cookie redirects to /login.
    const dashRes = await server.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { cookie: authedCookie },
    });
    expect(dashRes.statusCode).toBe(302);
    expect(dashRes.headers['location']).toMatch(/\/login/);
  });

  it('locks out after repeated failed attempts', async () => {
    // Hammer the login with wrong passwords beyond the threshold (5).
    let lastRes;
    for (let i = 0; i < 6; i++) {
      const { csrf, cookie } = await loginPagePrelude();
      lastRes = await server.inject({
        method: 'POST',
        url: '/login',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
        payload: `password=wrong-${i}&_csrf=${encodeURIComponent(csrf)}`,
      });
    }

    // Next attempt should be locked out -- the /login page shows the lockout message.
    const cookie = cookieHeader(lastRes!) || (await loginPagePrelude()).cookie;
    const loginRes = await server.inject({
      method: 'GET',
      url: '/login',
      headers: { cookie },
    });
    expect(loginRes.body).toContain('Too many failed attempts');
  });
});
