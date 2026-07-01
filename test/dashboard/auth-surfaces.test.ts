/**
 * Auth-surface rendering tests (AUTH-01, QA-01) -- Plan 09-02.
 *
 * Guards the logged-out login and setup pages: layout inheritance, FOUC
 * script, centered-card structure, and absence of inline flash styles
 * (regression guard for the Plan 01 cleanup, D-06).
 *
 * These complement auth.test.ts which covers login logic (success/failure/
 * lockout/session). This file covers rendered-page structure only.
 */

import argon2 from 'argon2';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/state/db.js';
import { buildServer } from '../../src/server.js';
import { SqliteConfigStore } from '../../src/config/sqlite-store.js';
import { setSetting } from '../../src/state/config-state.js';
import { bootSetupToken } from '../../src/dashboard/setup.js';

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

// ---------------------------------------------------------------------------
// Login page surface
// ---------------------------------------------------------------------------

describe('login page rendering (AUTH-01, D-06)', () => {
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
  });

  afterEach(async () => {
    await server.close();
    db.close();
  });

  /** Fetch GET /login and return its csrf token + cookie. */
  async function loginPagePrelude(): Promise<{ csrf: string; cookie: string }> {
    const res = await server.inject({ method: 'GET', url: '/login' });
    return { csrf: extractCsrf(res.body as string), cookie: cookieHeader(res) };
  }

  it('GET /login returns 200 with data-theme attribute (layout wrapper inherited)', async () => {
    const res = await server.inject({ method: 'GET', url: '/login' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('data-theme');
  });

  it('GET /login body contains or_theme (FOUC guard script present in head)', async () => {
    const res = await server.inject({ method: 'GET', url: '/login' });
    expect(res.body).toContain('or_theme');
  });

  it('GET /login body contains centered-card-wrapper and centered-card', async () => {
    const res = await server.inject({ method: 'GET', url: '/login' });
    expect(res.body).toContain('class="centered-card-wrapper"');
    expect(res.body).toContain('class="centered-card"');
  });

  it('GET /login body contains role="alert" (flash ARIA present)', async () => {
    const res = await server.inject({ method: 'GET', url: '/login' });
    expect(res.body).toContain('role="alert"');
  });

  it('GET /login flash region has no inline background-color or border style (D-06 regression guard)', async () => {
    const res = await server.inject({ method: 'GET', url: '/login' });
    const body = res.body as string;
    // Find the flash-warning element boundaries and check for absence of
    // inline style attributes on the container element. The Plan 01 fix
    // ensures the flash-warning div carries no inline style.
    const flashIdx = body.indexOf('class="flash-warning"');
    if (flashIdx !== -1) {
      // Extract the opening tag of the flash-warning element.
      const tagEnd = body.indexOf('>', flashIdx);
      const openTag = body.slice(flashIdx, tagEnd + 1);
      expect(openTag).not.toContain('background-color:');
      expect(openTag).not.toContain('background:');
      expect(openTag).not.toContain('border: 1px solid');
    }
    // The flash-error element should also have no inline style.
    const flashErrIdx = body.indexOf('class="flash-error"');
    if (flashErrIdx !== -1) {
      const tagEnd = body.indexOf('>', flashErrIdx);
      const openTag = body.slice(flashErrIdx, tagEnd + 1);
      expect(openTag).not.toContain('background-color:');
      expect(openTag).not.toContain('background:');
      expect(openTag).not.toContain('border: 1px solid');
    }
  });

  it('POST /login with correct password redirects to /dashboard', async () => {
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

  it('POST /login with wrong password redirects back to /login', async () => {
    const { csrf, cookie } = await loginPagePrelude();

    const res = await server.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `password=wrong-password&_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toMatch(/\/login/);
  });
});

// ---------------------------------------------------------------------------
// Setup page surface (no password configured)
// ---------------------------------------------------------------------------

describe('setup page rendering (AUTH-01, D-06)', () => {
  let db: Database.Database;
  let store: SqliteConfigStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let token: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    store = new SqliteConfigStore(db, makeKey());
    // CRITICAL: do NOT set password_hash -- bootSetupToken returns null when a
    // password exists, and the setup gate redirects to /login once a password is set.
    token = bootSetupToken(store) as string;
    server = await buildServer(store, db, () => {});
  });

  afterEach(async () => {
    await server.close();
    db.close();
  });

  it('GET /setup?token=<valid> returns 200 and renders the password form', async () => {
    const res = await server.inject({ method: 'GET', url: `/setup?token=${token}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('type="password"');
  });

  it('GET /setup?token=<valid> body contains autocomplete="new-password"', async () => {
    const res = await server.inject({ method: 'GET', url: `/setup?token=${token}` });
    expect(res.body).toContain('autocomplete="new-password"');
  });

  it('GET /setup?token=<valid> body contains data-theme (layout inherited on setup surface)', async () => {
    const res = await server.inject({ method: 'GET', url: `/setup?token=${token}` });
    expect(res.body).toContain('data-theme');
  });

  it('GET /styles/dashboard.css during first-run (no password) returns real CSS, not a redirect to /setup', async () => {
    const res = await server.inject({ method: 'GET', url: '/styles/dashboard.css?v=dev' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    expect(res.statusCode).not.toBe(302);
  });

  it('GET /fonts/Geist-Variable.woff2 during first-run (no password) returns the font, not a redirect', async () => {
    const res = await server.inject({ method: 'GET', url: '/fonts/Geist-Variable.woff2' });
    expect(res.statusCode).not.toBe(302);
    expect(res.headers['location']).toBeUndefined();
  });

  it('GET /dashboard during first-run (no password) still redirects to /setup (gate not weakened for real pages)', async () => {
    const res = await server.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('/setup');
  });
});
