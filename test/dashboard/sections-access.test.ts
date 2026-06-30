/**
 * Access section route tests (DSEC-01, DSEC-02, DCFG-01) -- Plan 05.
 *
 * Covers:
 *   Task 1 -- Change password: POST /dashboard/settings/password
 *     - Success: correct current password + new password >= 12 + confirm match
 *     - Wrong current password
 *     - New password too short
 *     - Passwords do not match
 *     - Session remains authenticated after successful password change
 *   Task 2 -- Domain: POST /dashboard/settings/domain
 *     - Valid bare hostname persists and store.domain reflects it
 *     - Scheme (https://) rejected without mutation
 *     - Trailing slash rejected without mutation
 *     - Blank input clears the domain (IP-only mode)
 *
 * Each test that hits a mutation route:
 *   1. Logs in via POST /login to get an authenticated session cookie.
 *   2. Generates a CSRF token via a GET /dashboard request.
 *   3. Sends the mutation with cookie + _csrf field.
 */

import argon2 from 'argon2';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../../src/state/db.js';
import { buildServer } from '../../src/server.js';
import { SqliteConfigStore } from '../../src/config/sqlite-store.js';
import { getSetting, setSetting } from '../../src/state/config-state.js';
import { lockoutMap } from '../../src/dashboard/auth.js';

const PASSWORD = 'access-test-pw-99';

function makeKey(): Buffer {
  return Buffer.alloc(32, 0x45);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cookieHeader(res: any): string {
  const raw = res.headers['set-cookie'] as string | string[] | undefined;
  if (!raw) return '';
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((c: string) => c.split(';')[0]).join('; ');
}

function extractCsrf(html: string): string {
  const m = /name="_csrf"[^>]*value="([^"]+)"/.exec(html);
  return m ? m[1]! : '';
}

// ---------------------------------------------------------------------------
// Task 1: Change-password route (DSEC-01)
// ---------------------------------------------------------------------------

describe('Access section -- change password (DSEC-01) -- Plan 05', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let store: SqliteConfigStore;
  let db: Database.Database;

  /** Log in and return the authenticated session cookie. */
  async function login(): Promise<string> {
    const getRes = await server.inject({ method: 'GET', url: '/login' });
    const csrf = extractCsrf(getRes.body as string);
    const loginRes = await server.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(getRes) },
      payload: `password=${encodeURIComponent(PASSWORD)}&_csrf=${encodeURIComponent(csrf)}`,
    });
    return cookieHeader(loginRes);
  }

  /** Obtain a fresh CSRF token in an authenticated session. */
  async function getAuthCsrf(cookie: string): Promise<string> {
    const res = await server.inject({
      method: 'GET',
      url: '/settings/general',
      headers: { cookie },
    });
    return extractCsrf(res.body as string);
  }

  beforeEach(async () => {
    db = openDb(':memory:');
    store = new SqliteConfigStore(db, makeKey());
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    setSetting('password_hash', hash);
    server = await buildServer(store, db, () => {});
    lockoutMap.clear();
  });

  afterEach(async () => {
    await server.close();
    db.close();
    lockoutMap.clear();
  });

  it('correct current password + valid new password replaces the hash', async () => {
    const authedCookie = await login();
    const csrf = await getAuthCsrf(authedCookie);

    const newPassword = 'new-secure-pass-2026';
    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/password',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: authedCookie },
      payload: [
        `currentPassword=${encodeURIComponent(PASSWORD)}`,
        `newPassword=${encodeURIComponent(newPassword)}`,
        `confirmPassword=${encodeURIComponent(newPassword)}`,
        `_csrf=${encodeURIComponent(csrf)}`,
      ].join('&'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Password changed');
    expect(res.body).toContain('remain signed in');

    // Verify the hash was actually changed.
    const newHash = getSetting('password_hash');
    expect(newHash).toBeTruthy();
    const valid = await argon2.verify(newHash!, newPassword);
    expect(valid).toBe(true);
    // Old password no longer valid.
    const oldValid = await argon2.verify(newHash!, PASSWORD);
    expect(oldValid).toBe(false);
  });

  it('session remains authenticated after a successful password change', async () => {
    const authedCookie = await login();
    const csrf = await getAuthCsrf(authedCookie);

    const newPassword = 'session-stays-valid-12';
    await server.inject({
      method: 'POST',
      url: '/dashboard/settings/password',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: authedCookie },
      payload: [
        `currentPassword=${encodeURIComponent(PASSWORD)}`,
        `newPassword=${encodeURIComponent(newPassword)}`,
        `confirmPassword=${encodeURIComponent(newPassword)}`,
        `_csrf=${encodeURIComponent(csrf)}`,
      ].join('&'),
    });

    // The original session cookie should still grant access to /dashboard.
    const dashRes = await server.inject({
      method: 'GET',
      url: '/settings/general',
      headers: { cookie: authedCookie },
    });
    expect(dashRes.statusCode).toBe(200);
  });

  it('wrong current password returns error and does not change the hash', async () => {
    const authedCookie = await login();
    const csrf = await getAuthCsrf(authedCookie);

    const originalHash = getSetting('password_hash');

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/password',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: authedCookie },
      payload: [
        `currentPassword=wrong-password-xyz`,
        `newPassword=new-secure-pass-2026`,
        `confirmPassword=new-secure-pass-2026`,
        `_csrf=${encodeURIComponent(csrf)}`,
      ].join('&'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Current password is incorrect');

    // Hash must not have changed.
    expect(getSetting('password_hash')).toBe(originalHash);
  });

  it('new password too short returns error and does not change the hash', async () => {
    const authedCookie = await login();
    const csrf = await getAuthCsrf(authedCookie);

    const originalHash = getSetting('password_hash');

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/password',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: authedCookie },
      payload: [
        `currentPassword=${encodeURIComponent(PASSWORD)}`,
        `newPassword=short`,
        `confirmPassword=short`,
        `_csrf=${encodeURIComponent(csrf)}`,
      ].join('&'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('at least 12 characters');

    // Hash must not have changed.
    expect(getSetting('password_hash')).toBe(originalHash);
  });

  it('password mismatch returns error and does not change the hash', async () => {
    const authedCookie = await login();
    const csrf = await getAuthCsrf(authedCookie);

    const originalHash = getSetting('password_hash');

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/password',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: authedCookie },
      payload: [
        `currentPassword=${encodeURIComponent(PASSWORD)}`,
        `newPassword=new-secure-pass-2026`,
        `confirmPassword=different-secure-pass-99`,
        `_csrf=${encodeURIComponent(csrf)}`,
      ].join('&'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('do not match');

    // Hash must not have changed.
    expect(getSetting('password_hash')).toBe(originalHash);
  });
});

// ---------------------------------------------------------------------------
// Task 2: Domain route (DSEC-02, DCFG-01)
// ---------------------------------------------------------------------------

describe('Access section -- domain (DSEC-02, DCFG-01) -- Plan 05', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let store: SqliteConfigStore;
  let db: Database.Database;

  /** Log in and return the authenticated session cookie. */
  async function login(): Promise<string> {
    const getRes = await server.inject({ method: 'GET', url: '/login' });
    const csrf = extractCsrf(getRes.body as string);
    const loginRes = await server.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(getRes) },
      payload: `password=${encodeURIComponent(PASSWORD)}&_csrf=${encodeURIComponent(csrf)}`,
    });
    return cookieHeader(loginRes);
  }

  /** Obtain a fresh CSRF token in an authenticated session. */
  async function getAuthCsrf(cookie: string): Promise<string> {
    const res = await server.inject({
      method: 'GET',
      url: '/settings/general',
      headers: { cookie },
    });
    return extractCsrf(res.body as string);
  }

  beforeEach(async () => {
    db = openDb(':memory:');
    store = new SqliteConfigStore(db, makeKey());
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    setSetting('password_hash', hash);
    server = await buildServer(store, db, () => {});
    lockoutMap.clear();
  });

  afterEach(async () => {
    await server.close();
    db.close();
    lockoutMap.clear();
  });

  it('valid bare hostname persists and store.domain reflects it live', async () => {
    const authedCookie = await login();
    const csrf = await getAuthCsrf(authedCookie);

    const domain = 'review.example.com';
    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/domain',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: authedCookie },
      payload: `domain=${encodeURIComponent(domain)}&_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Domain saved');
    // Response contains either success flash (HTTPS provisioning) or error flash
    // (Caddy not available in CI) -- both begin with 'Domain saved'.

    // store.domain reads live from SQLite.
    expect(store.domain).toBe(domain);
  });

  it('domain with https:// scheme is rejected without mutation', async () => {
    const authedCookie = await login();
    const csrf = await getAuthCsrf(authedCookie);

    // Pre-set a known domain to verify it does not change.
    setSetting('domain', 'original.example.com');

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/domain',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: authedCookie },
      payload: `domain=${encodeURIComponent('https://review.example.com')}&_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('plain domain name');

    // Domain must not have changed.
    expect(store.domain).toBe('original.example.com');
  });

  it('domain with trailing slash is rejected without mutation', async () => {
    const authedCookie = await login();
    const csrf = await getAuthCsrf(authedCookie);

    setSetting('domain', 'original.example.com');

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/domain',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: authedCookie },
      payload: `domain=${encodeURIComponent('review.example.com/')}&_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('plain domain name');

    // Domain must not have changed.
    expect(store.domain).toBe('original.example.com');
  });

  it('blank domain clears the stored domain (IP-only mode)', async () => {
    const authedCookie = await login();
    const csrf = await getAuthCsrf(authedCookie);

    // Pre-set a domain.
    setSetting('domain', 'review.example.com');
    expect(store.domain).toBe('review.example.com');

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/domain',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: authedCookie },
      payload: `domain=&_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Domain saved');

    // store.domain should now be undefined (IP-only mode).
    expect(store.domain).toBeUndefined();
  });
});
