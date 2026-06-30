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
  // POST /dashboard/repos -- add repo
  // -------------------------------------------------------------------------

  it('POST /dashboard/repos with valid owner/repo adds it and returns 200', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/repos',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}&repo=octocat%2Fhello-world`,
    });

    expect(res.statusCode).toBe(200);
    expect(store.repos).toContain('octocat/hello-world');
  });

  it('adding a repo updates store.repos live (DCFG-05)', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    await server.inject({
      method: 'POST',
      url: '/dashboard/repos',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}&repo=myorg%2Fmyrepo`,
    });

    expect(store.repos).toContain('myorg/myrepo');
  });

  it('adding a malformed repo (no slash) returns error flash and does not change allowlist', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/repos',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}&repo=notvalid`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('[x]');
    // Format error copy from UI-SPEC.
    expect(res.body).toContain('owner/repo');
    expect(store.repos).not.toContain('notvalid');
  });

  it('adding a malformed repo (multiple slashes) returns error flash', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/repos',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}&repo=org%2Frepo%2Fextra`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('[x]');
  });

  it('adding a duplicate repo returns duplicate error flash without changing the list', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    // Add first time.
    await server.inject({
      method: 'POST',
      url: '/dashboard/repos',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}&repo=octocat%2Fhello-world`,
    });

    // Add again -- duplicate.
    const csrf2 = await getAuthCsrf(cookie);
    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/repos',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf2)}&repo=octocat%2Fhello-world`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('[x]');
    // Only one copy.
    expect(store.repos.filter((r) => r === 'octocat/hello-world').length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // DELETE /dashboard/repos/:repo -- remove repo
  // -------------------------------------------------------------------------

  it('DELETE /dashboard/repos/:repo removes it from the allowlist', async () => {
    const cookie = await login();

    // Pre-populate the allowlist.
    setSetting('repos', JSON.stringify(['octocat/hello-world', 'myorg/myrepo']));

    const csrf = await getAuthCsrf(cookie);

    const res = await server.inject({
      method: 'DELETE',
      url: '/dashboard/repos/octocat%2Fhello-world',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(store.repos).not.toContain('octocat/hello-world');
    expect(store.repos).toContain('myorg/myrepo');
  });

  it('remove updates store.repos live (DCFG-05)', async () => {
    const cookie = await login();

    setSetting('repos', JSON.stringify(['delete-me/repo']));
    expect(store.repos).toContain('delete-me/repo');

    const csrf = await getAuthCsrf(cookie);

    await server.inject({
      method: 'DELETE',
      url: '/dashboard/repos/delete-me%2Frepo',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(store.repos).not.toContain('delete-me/repo');
  });

  // -------------------------------------------------------------------------
  // Empty allowlist state
  // -------------------------------------------------------------------------

  it('repos partial renders empty-state copy when allowlist is empty', async () => {
    const cookie = await login();

    const res = await server.inject({
      method: 'GET',
      url: '/settings/repos',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('No repositories configured');
  });

  // Wave 0 RED: green after Plan 05
  it('GET /settings/repos renders repos as a .card-repo-grid (ACT-03)', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    await server.inject({
      method: 'POST',
      url: '/dashboard/repos',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `_csrf=${encodeURIComponent(csrf)}&repo=myorg%2Fmyrepo`,
    });

    const res = await server.inject({
      method: 'GET',
      url: '/settings/repos',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('card-repo-grid');
  });
});
