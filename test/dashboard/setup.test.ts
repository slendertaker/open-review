/**
 * Dashboard first-run setup tests (DSEC-01, D2-09) -- Plan 02.
 *
 * Tests the setup-token gate, GET/POST /setup routes, bootSetupToken behavior,
 * and the FIRST RUN log emission.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../../src/state/db.js';
import { buildServer } from '../../src/server.js';
import { SqliteConfigStore } from '../../src/config/sqlite-store.js';
import { bootSetupToken } from '../../src/dashboard/setup.js';
import { setSetting } from '../../src/state/config-state.js';
import * as logger from '../../src/logger.js';

function makeKey(): Buffer {
  return Buffer.alloc(32, 0x42);
}

function createTestDb(): Database.Database {
  // Use an in-memory DB; openDb wires all initX functions.
  return openDb(':memory:');
}

/**
 * Extract just the name=value pairs from set-cookie headers, dropping the
 * attributes (Path, Expires, HttpOnly, SameSite) so the result is a valid
 * request Cookie header.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cookieHeader(res: any): string {
  const raw = res.headers['set-cookie'] as string | string[] | undefined;
  if (!raw) return '';
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.map((c) => c.split(';')[0]).join('; ');
}

/** Extract the _csrf hidden input value from rendered HTML. */
function extractCsrf(html: string): string {
  const m = /name="_csrf"[^>]*value="([^"]+)"/.exec(html);
  return m ? m[1]! : '';
}

describe('dashboard first-run setup (DSEC-01) -- Plan 02', () => {
  let db: Database.Database;
  let store: SqliteConfigStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

  beforeEach(async () => {
    db = createTestDb();
    store = new SqliteConfigStore(db, makeKey());
    server = await buildServer(store, db, () => {});
  });

  afterEach(async () => {
    await server.close();
    db.close();
  });

  // ---------------------------------------------------------------------------
  // bootSetupToken
  // ---------------------------------------------------------------------------

  it('bootSetupToken returns a token and logs setup URL when no password is set', () => {
    // Spy on the logger to assert the log call.
    const infoSpy = vi.spyOn(logger.log, 'info');

    const token = bootSetupToken(store);

    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
    expect(token!.length).toBeGreaterThan(0);

    // The setup URL must have been logged.
    expect(infoSpy).toHaveBeenCalled();
    const calls = infoSpy.mock.calls;
    const loggedSetupUrl = calls.some((call) => {
      const arg0 = call[0] as Record<string, unknown> | undefined;
      const arg1 = call[1] as string | undefined;
      return (
        typeof arg0 === 'object' &&
        arg0 !== null &&
        typeof arg0['setupUrl'] === 'string' &&
        typeof arg1 === 'string' &&
        arg1.includes('FIRST RUN')
      );
    });
    expect(loggedSetupUrl).toBe(true);

    infoSpy.mockRestore();
  });

  it('bootSetupToken returns null and does NOT log setup URL when password is already set', () => {
    // Set a password hash.
    setSetting('password_hash', '$argon2id$fake-hash');

    const infoSpy = vi.spyOn(logger.log, 'info');

    const token = bootSetupToken(store);

    expect(token).toBeNull();

    // The FIRST RUN URL must NOT have been logged.
    const calls = infoSpy.mock.calls;
    const loggedFirstRun = calls.some((call) => {
      const arg1 = call[1] as string | undefined;
      return typeof arg1 === 'string' && arg1.includes('FIRST RUN');
    });
    expect(loggedFirstRun).toBe(false);

    infoSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Setup gate: unauthenticated requests redirect to /setup when no password set
  // ---------------------------------------------------------------------------

  it('GET /dashboard with no password redirects to /setup', async () => {
    const res = await server.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toMatch(/\/setup/);
  });

  // ---------------------------------------------------------------------------
  // GET /setup
  // ---------------------------------------------------------------------------

  it('GET /setup with a valid token renders the setup form (200)', async () => {
    // Generate a token first.
    const token = bootSetupToken(store);
    expect(token).toBeTruthy();

    const res = await server.inject({
      method: 'GET',
      url: `/setup?token=${token!}`,
    });

    expect(res.statusCode).toBe(200);
    // The form should contain a password input.
    expect(res.body).toContain('password');
  });

  it('GET /setup with an invalid token renders the invalid-token error state (no form)', async () => {
    // Generate a valid token but query with a wrong one.
    bootSetupToken(store);

    const res = await server.inject({
      method: 'GET',
      url: '/setup?token=wrongtoken123',
    });

    expect(res.statusCode).toBe(200);
    // Error message should appear; form should not render new/confirm password inputs.
    expect(res.body).toContain('invalid or has already been used');
  });

  // ---------------------------------------------------------------------------
  // POST /setup
  // ---------------------------------------------------------------------------

  it('POST /setup with password already set redirects to /login', async () => {
    setSetting('password_hash', '$argon2id$fake-existing-hash');

    // Need a CSRF token. First get a session and CSRF token from GET /setup.
    const validToken = 'fake-token';
    setSetting('setup_token', validToken);

    // GET /setup with password already set redirects to /login (no form/cookie).
    const getRes = await server.inject({
      method: 'GET',
      url: `/setup?token=${validToken}`,
    });

    // The onRequest gate redirects /setup to /login once a password exists,
    // BEFORE CSRF protection runs, so a stale POST cleanly redirects too.
    const res = await server.inject({
      method: 'POST',
      url: '/setup',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(getRes),
      },
      payload: `token=${validToken}&password=testpassword123&confirm=testpassword123&_csrf=fake`,
    });

    // Password already set -> redirect to /login
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toMatch(/\/login/);
  });

  it('POST /setup with valid token and matching password >= 12 chars stores hash and redirects to /dashboard', async () => {
    // Generate a token.
    const token = bootSetupToken(store);
    expect(token).toBeTruthy();

    // Get the CSRF token via GET /setup.
    const getRes = await server.inject({
      method: 'GET',
      url: `/setup?token=${token!}`,
    });
    expect(getRes.statusCode).toBe(200);

    const cookies = cookieHeader(getRes);
    const csrfToken = extractCsrf(getRes.body as string);
    expect(csrfToken).toBeTruthy();

    const password = 'strongpassword123';
    const postRes = await server.inject({
      method: 'POST',
      url: '/setup',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookies,
      },
      payload: `token=${token!}&password=${password}&confirm=${password}&_csrf=${encodeURIComponent(csrfToken)}`,
    });

    // Should redirect to /dashboard after successful setup.
    expect(postRes.statusCode).toBe(302);
    expect(postRes.headers['location']).toMatch(/\/dashboard/);
  });

  it('setup token is invalidated after the password is set', async () => {
    const token = bootSetupToken(store);
    expect(token).toBeTruthy();

    // Get CSRF token.
    const getRes = await server.inject({
      method: 'GET',
      url: `/setup?token=${token!}`,
    });
    const cookies = cookieHeader(getRes);
    const csrfToken = extractCsrf(getRes.body as string);

    // First POST: sets password.
    const password = 'anotherpassword456';
    await server.inject({
      method: 'POST',
      url: '/setup',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookies,
      },
      payload: `token=${token!}&password=${password}&confirm=${password}&_csrf=${encodeURIComponent(csrfToken)}`,
    });

    // Second POST with the same token should redirect to /login (password now set).
    const secondGet = await server.inject({
      method: 'GET',
      url: `/setup?token=${token!}`,
    });

    // After password is set, GET /setup redirects to /login.
    expect(secondGet.statusCode).toBe(302);
    expect(secondGet.headers['location']).toMatch(/\/login/);
  });
});
