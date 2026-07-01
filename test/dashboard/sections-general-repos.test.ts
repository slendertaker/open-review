/**
 * General and Repositories section route tests (DCFG-01, DCFG-03, DCFG-05) -- Plan 03.
 *
 * Covers:
 *   Task 1 -- General section: POST /dashboard/settings/general save + validation
 *   Task 2 -- Repositories: POST /dashboard/repos add, DELETE /dashboard/repos/:repo remove
 *
 * Each test that hits a mutation route:
 *   1. Logs in via POST /login to get an authenticated session cookie.
 *   2. Generates a CSRF token via a GET request.
 *   3. Sends the mutation with cookie + _csrf field.
 */

import argon2 from 'argon2';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/state/db.js';
import { buildServer } from '../../src/server.js';
import { SqliteConfigStore } from '../../src/config/sqlite-store.js';
import { setSetting } from '../../src/state/config-state.js';
import { lockoutMap } from '../../src/dashboard/auth.js';

const PASSWORD = 'test-password-123';

function makeKey(): Buffer {
  return Buffer.alloc(32, 0x43);
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

describe('General section (DCFG-01, DCFG-05) -- Plan 03', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let store: SqliteConfigStore;

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
    const db = openDb(':memory:');
    store = new SqliteConfigStore(db, makeKey());
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    setSetting('password_hash', hash);
    server = await buildServer(store, db, () => {});
    lockoutMap.clear();
  });

  afterEach(async () => {
    await server.close();
    lockoutMap.clear();
  });

  // -------------------------------------------------------------------------
  // POST /dashboard/settings/general -- valid save
  // -------------------------------------------------------------------------

  it('POST /dashboard/settings/general with valid fields returns 200 and success flash', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/general',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: [
        `_csrf=${encodeURIComponent(csrf)}`,
        'minSeverity=high',
        'ignoreGlobs=dist/**',
      ].join('&'),
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Settings saved.');
  });

  it('saving General updates store.minSeverity live (DCFG-05)', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    await server.inject({
      method: 'POST',
      url: '/dashboard/settings/general',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: [
        `_csrf=${encodeURIComponent(csrf)}`,
        'minSeverity=critical',
        'ignoreGlobs=dist/**',
      ].join('&'),
    });

    expect(store.minSeverity).toBe('critical');
  });

  it('saving General with skipDrafts checked updates store.skipDrafts live', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    await server.inject({
      method: 'POST',
      url: '/dashboard/settings/general',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: [
        `_csrf=${encodeURIComponent(csrf)}`,
        'minSeverity=medium',
        'skipDrafts=on',
        'ignoreGlobs=dist/**',
      ].join('&'),
    });

    expect(store.skipDrafts).toBe(true);
  });

  it('saving General without skipForks unchecked stores false and updates store.skipForks live', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    // skipForks absent (checkbox unchecked) -> false
    await server.inject({
      method: 'POST',
      url: '/dashboard/settings/general',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: [
        `_csrf=${encodeURIComponent(csrf)}`,
        'minSeverity=medium',
        'ignoreGlobs=dist/**',
      ].join('&'),
    });

    expect(store.skipForks).toBe(false);
  });

  it('saving General with ignore globs updates store.ignoreGlobs live', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    await server.inject({
      method: 'POST',
      url: '/dashboard/settings/general',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: [
        `_csrf=${encodeURIComponent(csrf)}`,
        'minSeverity=medium',
        `ignoreGlobs=${encodeURIComponent('dist/**\nbuild/**')}`,
      ].join('&'),
    });

    expect(store.ignoreGlobs).toContain('dist/**');
    expect(store.ignoreGlobs).toContain('build/**');
  });

  // -------------------------------------------------------------------------
  // POST /dashboard/settings/general -- validation errors
  // -------------------------------------------------------------------------

  it('POST with invalid minSeverity returns error flash and does not mutate storage', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    // Set a known current value.
    setSetting('min_severity', 'low');

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/general',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: [
        `_csrf=${encodeURIComponent(csrf)}`,
        'minSeverity=extreme',
        'ignoreGlobs=dist/**',
      ].join('&'),
    });

    expect(res.statusCode).toBe(200);
    // Error flash must appear.
    expect(res.body).toContain('[x]');
    // Stored value must remain unchanged.
    expect(store.minSeverity).toBe('low');
  });

  // -------------------------------------------------------------------------
  // Auth guard: unauthenticated POST is rejected
  // -------------------------------------------------------------------------

  it('unauthenticated POST /dashboard/settings/general returns 4xx', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/general',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'minSeverity=medium&ignoreGlobs=dist/**&_csrf=fake',
    });

    // Unauthenticated -> redirect to /login (302) or CSRF failure (403).
    expect([302, 403]).toContain(res.statusCode);
  });

  // D-07: a CSRF token minted by the htmx fragment path is accepted by the POST handler
  it('CSRF minted from GET /settings/general htmx fragment is accepted by POST /dashboard/settings/general (D-07)', async () => {
    const cookie = await login();

    // Fetch the fragment -- the new /settings/general route mints a session-valid CSRF
    const fragRes = await server.inject({
      method: 'GET',
      url: '/settings/general',
      headers: { cookie, 'hx-request': 'true' },
    });

    // This is RED until Wave 1 lands the /settings/general route. Once it does:
    // the fragment must contain a non-undefined _csrf input.
    const csrf = extractCsrf(fragRes.body as string);

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/general',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: [
        `_csrf=${encodeURIComponent(csrf)}`,
        'minSeverity=high',
        'ignoreGlobs=dist/**',
      ].join('&'),
    });

    // Proves the fragment-minted token is session-valid (not a 403 CSRF rejection).
    expect(res.statusCode).toBe(200);
  });
});

// =============================================================================
// Task 2: Repositories allowlist (DCFG-03, DCFG-05)
// =============================================================================

describe('Repositories section (DCFG-03, DCFG-05) -- Plan 03', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let store: SqliteConfigStore;

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

  async function getAuthCsrf(cookie: string): Promise<string> {
    const res = await server.inject({ method: 'GET', url: '/settings/general', headers: { cookie } });
    return extractCsrf(res.body as string);
  }

  beforeEach(async () => {
    const db = openDb(':memory:');
    store = new SqliteConfigStore(db, makeKey());
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    setSetting('password_hash', hash);
    server = await buildServer(store, db, () => {});
    lockoutMap.clear();
  });

  afterEach(async () => {
    await server.close();
    lockoutMap.clear();
  });

  // -------------------------------------------------------------------------
  // POST /settings/repos/:owner/:repo -- save enabled + severity/globs overrides
  // -------------------------------------------------------------------------

  it('POST /settings/repos/:owner/:repo with enabled=on adds it to store.repos', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    const res = await server.inject({
      method: 'POST',
      url: '/settings/repos/octocat/hello-world',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}&enabled=on`,
    });

    expect(res.statusCode).toBe(200);
    expect(store.repos).toContain('octocat/hello-world');
  });

  it('saving enabled=on updates store.repos live (DCFG-05)', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    await server.inject({
      method: 'POST',
      url: '/settings/repos/myorg/myrepo',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}&enabled=on`,
    });

    expect(store.repos).toContain('myorg/myrepo');
  });

  it('POST with an invalid owner path segment returns 400 and does not change the allowlist', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    const res = await server.inject({
      method: 'POST',
      url: '/settings/repos/.invalid/hello-world',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}&enabled=on`,
    });

    expect(res.statusCode).toBe(400);
    expect(store.repos).toEqual([]);
  });

  it('disabling a previously-enabled repo removes it from the allowlist', async () => {
    const cookie = await login();
    let csrf = await getAuthCsrf(cookie);

    await server.inject({
      method: 'POST',
      url: '/settings/repos/octocat/hello-world',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}&enabled=on`,
    });
    expect(store.repos).toContain('octocat/hello-world');

    // Re-submit with the enabled checkbox absent (unchecked).
    csrf = await getAuthCsrf(cookie);
    const res = await server.inject({
      method: 'POST',
      url: '/settings/repos/octocat/hello-world',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(store.repos).not.toContain('octocat/hello-world');
  });

  it('a minSeverity override is saved and readable via store.repoConfig, without changing the global default', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    await server.inject({
      method: 'POST',
      url: '/settings/repos/octocat/hello-world',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}&enabled=on&minSeverity=critical`,
    });

    expect(store.repoConfig('octocat/hello-world').minSeverity).toBe('critical');
    expect(store.minSeverity).toBe('medium');
  });

  it('an ignoreGlobs override is saved and readable via store.repoConfig', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    await server.inject({
      method: 'POST',
      url: '/settings/repos/octocat/hello-world',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}&enabled=on&${encodeURIComponent('ignoreGlobs')}=${encodeURIComponent('dist/**\nbuild/**')}`,
    });

    expect(store.repoConfig('octocat/hello-world').ignoreGlobs).toEqual(['dist/**', 'build/**']);
  });

  it('a blank minSeverity/ignoreGlobs means inherit the global default', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    await server.inject({
      method: 'POST',
      url: '/settings/repos/octocat/hello-world',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}&enabled=on&minSeverity=&ignoreGlobs=`,
    });

    const config = store.repoConfig('octocat/hello-world');
    expect(config.minSeverity).toBe(store.minSeverity);
    expect(config.ignoreGlobs).toEqual(store.ignoreGlobs);
  });

  // -------------------------------------------------------------------------
  // GET /settings/repos and GET /settings/repos/:owner/:repo
  // -------------------------------------------------------------------------

  it('GET /settings/repos shows the not-connected empty state when no GitHub App is connected', async () => {
    const cookie = await login();

    const res = await server.inject({
      method: 'GET',
      url: '/settings/repos',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Connect GitHub first');
  });

  it('GET /settings/repos/:owner/:repo renders the current enabled state', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    await server.inject({
      method: 'POST',
      url: '/settings/repos/octocat/hello-world',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}&enabled=on`,
    });

    const res = await server.inject({
      method: 'GET',
      url: '/settings/repos/octocat/hello-world',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('octocat/hello-world');
    expect(res.body).toContain('checked');
  });
});
