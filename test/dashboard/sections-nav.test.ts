/**
 * Sidebar shell and hybrid routing tests (NAV-01, NAV-02, NAV-03, NAV-04, D-06, D-07).
 *
 * Wave 0 RED scaffold. The /settings/* routes and sidebar shell do not exist yet
 * (created in Waves 1-2). These tests are expected to FAIL until those waves ship
 * the production code.
 *
 * Covers:
 *   NAV-01 - full-shell load contains #sidebar and #content
 *   NAV-04 - HX-Request load returns bare fragment (no <html>, no #sidebar)
 *   D-07   - fragment carries a non-undefined _csrf token
 *   NAV-03 - each sub-page route exists and renders the shell
 *   D-06   - /settings/health/partial returns a fragment (no <html>)
 *   NAV-02 - /settings/github fragment contains an OOB #sidebar-context
 *
 * All imports use .js extension per NodeNext ESM resolution.
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

describe('Sidebar shell + hybrid routing (NAV-01..04)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

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

  beforeEach(async () => {
    const db = openDb(':memory:');
    const store = new SqliteConfigStore(db, makeKey());
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    setSetting('password_hash', hash);
    server = await buildServer(store, db, () => {});
    lockoutMap.clear();
  });

  afterEach(async () => {
    await server.close();
    lockoutMap.clear();
  });

  // ---------------------------------------------------------------------------
  // NAV-01: full-shell load contains #sidebar and #content
  // ---------------------------------------------------------------------------

  it('GET /settings/general without HX-Request returns full HTML with #sidebar and #content', async () => {
    const cookie = await login();
    const res = await server.inject({
      method: 'GET',
      url: '/settings/general',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body as string).toContain('id="sidebar"');
    expect(res.body as string).toContain('id="content"');
  });

  // ---------------------------------------------------------------------------
  // NAV-04: HX-Request path returns bare fragment (no <html>, no #sidebar)
  // ---------------------------------------------------------------------------

  it('GET /settings/general with hx-request: true returns bare fragment without <html> or #sidebar', async () => {
    const cookie = await login();
    const res = await server.inject({
      method: 'GET',
      url: '/settings/general',
      headers: { cookie, 'hx-request': 'true' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body as string).not.toContain('<html');
    expect(res.body as string).not.toContain('id="sidebar"');
  });

  // ---------------------------------------------------------------------------
  // D-07: fragment carries a non-undefined _csrf token
  // ---------------------------------------------------------------------------

  it('GET /settings/general htmx fragment includes a non-undefined _csrf input', async () => {
    const cookie = await login();
    const res = await server.inject({
      method: 'GET',
      url: '/settings/general',
      headers: { cookie, 'hx-request': 'true' },
    });
    expect(res.body as string).toMatch(/name="_csrf"[^>]*value="(?!undefined)[^"]+"/);
  });

  // ---------------------------------------------------------------------------
  // NAV-03: each sub-page route exists and renders the shell (full-load path)
  // ---------------------------------------------------------------------------

  it('each settings sub-page returns 200 with #sidebar on a direct GET', async () => {
    const cookie = await login();
    const subPages = ['general', 'provider', 'secrets', 'github', 'repos', 'access', 'health'];
    for (const s of subPages) {
      const res = await server.inject({
        method: 'GET',
        url: `/settings/${s}`,
        headers: { cookie },
      });
      expect(res.statusCode, `/settings/${s} should return 200`).toBe(200);
      expect((res.body as string), `/settings/${s} should contain sidebar`).toContain('id="sidebar"');
    }
  });

  // ---------------------------------------------------------------------------
  // D-06: /settings/health/partial returns a fragment (no <html>)
  // ---------------------------------------------------------------------------

  it('GET /settings/health/partial returns a health fragment without full HTML shell', async () => {
    const cookie = await login();
    const res = await server.inject({
      method: 'GET',
      url: '/settings/health/partial',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body as string).not.toContain('<html');
  });

  // ---------------------------------------------------------------------------
  // NAV-02: /settings/github htmx fragment contains OOB #sidebar-context
  // ---------------------------------------------------------------------------

  it('GET /settings/github with hx-request: true returns fragment with OOB sidebar-context', async () => {
    const cookie = await login();
    const res = await server.inject({
      method: 'GET',
      url: '/settings/github',
      headers: { cookie, 'hx-request': 'true' },
    });
    expect(res.body as string).toContain('id="sidebar-context"');
    expect(res.body as string).toContain('hx-swap-oob');
  });
});
