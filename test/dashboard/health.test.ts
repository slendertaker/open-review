/**
 * Dashboard health aggregation tests (DACT-03).
 *
 * Covers: GET /activity/partial (the health partial route)
 *   - Queue depth from job_queue counts
 *   - Active provider + credential presence
 *   - Last review from review_runs
 *   - Auth gate (redirect/401 without cookie)
 *
 * NOTE: This is a Wave 0 RED test scaffold. The /activity/partial route
 * does not exist yet (created in Plan 03). These tests are expected to
 * FAIL until Plans 02-03 ship the production code.
 *
 * All imports use .js extension per NodeNext ESM resolution.
 */

import argon2 from 'argon2';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/state/db.js';
import { buildServer } from '../../src/server.js';
import { SqliteConfigStore } from '../../src/config/sqlite-store.js';
import { setSetting, setSecretRecord } from '../../src/state/config-state.js';
import { lockoutMap } from '../../src/dashboard/auth.js';
import { encryptSecret } from '../../src/config/crypto.js';

const PASSWORD = 'test-password-health';

function makeKey(): Buffer {
  return Buffer.alloc(32, 0x48);
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

describe('Health aggregation partial (DACT-03)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let store: SqliteConfigStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  const KEY = makeKey();

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
    db = openDb(':memory:');
    store = new SqliteConfigStore(db, KEY);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    setSetting('password_hash', hash);
    server = await buildServer(store, db, () => {});
    lockoutMap.clear();
  });

  afterEach(async () => {
    await server.close();
    lockoutMap.clear();
  });

  // DACT-03: queue depth from job_queue
  it('GET /activity/partial (authenticated) returns 200 and renders queue depth from job_queue counts', async () => {
    const cookie = await login();

    // Insert job_queue rows directly: 2 pending, 1 running
    // Note: job_queue schema has created_at but no updated_at column.
    db.prepare(
      `INSERT INTO job_queue (pr_id, payload, status, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).run('owner/repo#1', '{}', 'pending');
    db.prepare(
      `INSERT INTO job_queue (pr_id, payload, status, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).run('owner/repo#2', '{}', 'pending');
    db.prepare(
      `INSERT INTO job_queue (pr_id, payload, status, created_at)
       VALUES (?, ?, ?, datetime('now'))`
    ).run('owner/repo#3', '{}', 'running');

    const res = await server.inject({
      method: 'GET',
      url: '/activity/partial',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    // Health panel must render the pending and running counts
    expect(res.body as string).toContain('2');  // pending count
    expect(res.body as string).toContain('1');  // running count
  });

  // DACT-03: provider and credential presence -- retargeted to /settings/health/partial
  // D-06 (plan 07-03) moved provider + credential info off /activity/partial and onto the
  // Health sub-page. This test now asserts on the new health endpoint instead.
  it('GET /settings/health/partial reflects the active provider and credential presence', async () => {
    const cookie = await login();

    // Default provider is 'claude'; no credential set yet
    setSetting('provider', 'claude');

    const res1 = await server.inject({
      method: 'GET',
      url: '/settings/health/partial',
      headers: { cookie },
    });

    expect(res1.statusCode).toBe(200);
    expect(res1.body as string).toContain('claude');

    // Now set a claude_oauth_token secret
    const encrypted = encryptSecret('test-oauth-token-value', KEY);
    setSecretRecord('claude_oauth_token', encrypted);

    const res2 = await server.inject({
      method: 'GET',
      url: '/settings/health/partial',
      headers: { cookie },
    });

    expect(res2.statusCode).toBe(200);
    // The credential presence indicator must appear on the health partial
    // Assert on stable token: body should mention 'claude' (provider) and credential indicator
    expect(res2.body as string).toContain('claude');
    expect(res2.body as string).toContain('credential present');
  });

  // DACT-03: last review from review_runs
  it('GET /activity/partial shows last review from the most recent review_runs row', async () => {
    const cookie = await login();

    // Insert a review_runs row via raw SQL.
    // NOTE: review_runs table is added to schema.sql by Plan 02.
    // Until then this insert will throw -- that is acceptable RED.
    db.prepare(`
      INSERT INTO review_runs
        (pr_id, owner, repo, pr_number, head_sha, base_sha, installation_id,
         provider, status, mode, finding_count, findings_json, summary, error, log,
         created_at, started_at, finished_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'), ?)
    `).run(
      'myorg/myrepo#77', 'myorg', 'myrepo', 77,
      'headabc123', 'basedef456', null,
      'claude', 'success', 'full', 3,
      '[]', 'Review complete, 3 findings.', null, '',
      1200
    );

    const res = await server.inject({
      method: 'GET',
      url: '/activity/partial',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    // Assert on the PR identifier or status from the inserted row
    expect(res.body as string).toMatch(/myrepo|success|77/);
  });

  // DACT-03 + T-03-04: auth gate
  it('GET /activity/partial requires login', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/activity/partial',
      // No cookie -- unauthenticated
    });

    // requireLogin redirects to /login (302) or returns 401
    expect([301, 302, 401]).toContain(res.statusCode);
  });

  // WR-01: the polled partial must be a bare fragment, not a layout-wrapped
  // full HTML document. htmx swaps this into the live DOM every 5s; a full
  // <!DOCTYPE>/<html>/<head>/<style> payload would be injected each poll.
  it('GET /activity/partial returns a bare fragment with no layout wrapper', async () => {
    const cookie = await login();

    const res = await server.inject({
      method: 'GET',
      url: '/activity/partial',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.body as string;
    expect(body).not.toContain('<!DOCTYPE');
    expect(body).not.toContain('<html');
    expect(body).not.toContain('<head');
  });
});
