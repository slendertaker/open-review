/**
 * Activity feed, detail, and re-trigger route tests (DACT-01, DACT-02, DACT-04).
 *
 * Covers:
 *   - GET /activity: feed lists inserted review runs (DACT-01)
 *   - GET /activity: login gate (T-03-04)
 *   - GET /activity/:id: detail page shows status, findings, summary (DACT-02)
 *   - GET /activity/:id: 400 on non-numeric id (T-03-02)
 *   - GET /activity/:id: 404 on unknown id
 *   - POST /activity/:id/retrigger: happy-path calls enqueue with reconstructed payload (DACT-04)
 *   - POST /activity/:id/retrigger: 403 without CSRF (T-03-01)
 *   - POST /activity/:id/retrigger: 404 for unknown id
 *   - POST /activity/:id/retrigger: omits installationId when row has installation_id NULL
 *
 * NOTE: This is a Wave 0 RED test scaffold. The /activity routes do not
 * exist yet (created in Plans 02-04). These tests are expected to FAIL
 * until those plans ship the production code.
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

const PASSWORD = 'test-password-activity';

function makeKey(): Buffer {
  return Buffer.alloc(32, 0x41);
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

describe('Activity feed + detail + re-trigger (DACT-01, DACT-02, DACT-04)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let store: SqliteConfigStore;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  let enqueueCalls: Array<{ prId: string; payload: string }>;

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

  /**
   * Get a CSRF token (authenticated). Fetched from /settings/general, which always
   * renders forms carrying a session-scoped _csrf token. (The /activity page no
   * longer carries a page-level orphan _csrf input -- IN-04 -- so an empty feed
   * exposes no token; CSRF tokens are session-bound and valid across routes.)
   * Note: /dashboard now redirects to /settings/general (D-02), so we fetch from
   * the destination directly.
   */
  async function getAuthCsrf(cookie: string): Promise<string> {
    const res = await server.inject({
      method: 'GET',
      url: '/settings/general',
      headers: { cookie },
    });
    return extractCsrf(res.body as string);
  }

  /**
   * Insert a review_runs row via raw SQL for test setup.
   * NOTE: review_runs table is added to schema.sql by Plan 02.
   * Until then this insert will throw -- that is acceptable RED.
   */
  function insertReviewRun(overrides: {
    prId?: string;
    owner?: string;
    repo?: string;
    prNumber?: number;
    headSha?: string;
    baseSha?: string;
    installationId?: number | null;
    status?: string;
    mode?: string;
    findingCount?: number;
    findingsJson?: string;
    summary?: string;
    error?: string | null;
  } = {}): number {
    const r = {
      prId: 'testorg/testrepo#42',
      owner: 'testorg',
      repo: 'testrepo',
      prNumber: 42,
      headSha: 'headaabbccdd',
      baseSha: 'baseeeff0011',
      installationId: 12345,
      status: 'success',
      mode: 'full',
      findingCount: 2,
      findingsJson: JSON.stringify([
        { file: 'src/api.ts', line: 10, severity: 'high', message: 'Potential SQL injection' },
        { file: 'src/util.ts', line: 5, severity: 'medium', message: 'Missing null check' },
      ]),
      summary: 'Detected 2 issues requiring attention.',
      error: null,
      ...overrides,
    };

    const info = db.prepare(`
      INSERT INTO review_runs
        (pr_id, owner, repo, pr_number, head_sha, base_sha, installation_id,
         provider, status, mode, finding_count, findings_json, summary, error, log,
         created_at, started_at, finished_at, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'claude', ?, ?, ?, ?, ?, ?, '',
              datetime('now'), datetime('now'), datetime('now'), 1500)
    `).run(
      r.prId, r.owner, r.repo, r.prNumber,
      r.headSha, r.baseSha, r.installationId ?? null,
      r.status, r.mode, r.findingCount,
      r.findingsJson, r.summary, r.error
    );

    return Number(info.lastInsertRowid);
  }

  beforeEach(async () => {
    enqueueCalls = [];
    db = openDb(':memory:');
    store = new SqliteConfigStore(db, makeKey());
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    setSetting('password_hash', hash);
    // Pass a capturing enqueue mock -- asserts re-trigger payload construction
    server = await buildServer(store, db, (prId: string, payload: string) => {
      enqueueCalls.push({ prId, payload });
    });
    lockoutMap.clear();
  });

  afterEach(async () => {
    await server.close();
    lockoutMap.clear();
  });

  // -------------------------------------------------------------------------
  // DACT-01: feed
  // -------------------------------------------------------------------------

  it('GET /activity (authenticated) returns 200 and lists an inserted review run', async () => {
    const cookie = await login();

    insertReviewRun({ repo: 'testrepo', prNumber: 42 });

    const res = await server.inject({
      method: 'GET',
      url: '/activity',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body as string).toContain('testrepo');
    expect(res.body as string).toMatch(/42|#42/);
  });

  // WR-02 / WR-03: the full feed page must contain exactly one #activity-list
  // and one 5s poller. After D-06, #health-panel is decoupled from /activity
  // and lives only on /settings/health. Previously activity.eta wrapped the
  // partial in its own polling container AND the partial re-emitted both ids,
  // producing duplicate ids and two parallel 5s pollers.
  it('GET /activity renders one #activity-list, one 5s poller, and no health-panel after D-06', async () => {
    const cookie = await login();

    insertReviewRun({ repo: 'testrepo', prNumber: 42 });

    const res = await server.inject({
      method: 'GET',
      url: '/activity',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.body as string;
    const activityListIds = body.match(/id="activity-list"/g) ?? [];
    const healthPanelIds = body.match(/id="health-panel"/g) ?? [];
    const pollers = body.match(/hx-trigger="every 5s"/g) ?? [];
    expect(activityListIds).toHaveLength(1);
    expect(healthPanelIds).toHaveLength(0);
    expect(pollers).toHaveLength(1);
  });

  // D-06: /activity/partial must not emit a health-panel OOB after the decouple
  it('GET /activity/partial does NOT contain health-panel OOB after D-06', async () => {
    const cookie = await login();

    const res = await server.inject({
      method: 'GET',
      url: '/activity/partial',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body as string).not.toContain('id="health-panel"');
    expect(res.body as string).not.toContain('hx-swap-oob');
  });

  // T-03-04: feed login gate
  it('GET /activity requires login', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/activity',
      // No cookie -- unauthenticated
    });

    // requireLogin redirects to /login (302) or returns 401
    expect([301, 302, 401]).toContain(res.statusCode);
  });

  // -------------------------------------------------------------------------
  // DACT-02: detail page
  // -------------------------------------------------------------------------

  it('GET /activity/:id returns 200 and shows status, finding count, and summary for that row', async () => {
    const cookie = await login();

    const id = insertReviewRun({
      status: 'success',
      findingCount: 2,
      summary: 'Detected 2 issues requiring attention.',
    });

    const res = await server.inject({
      method: 'GET',
      url: `/activity/${id}`,
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body as string).toContain('success');
    expect(res.body as string).toContain('2');
    expect(res.body as string).toContain('Detected 2 issues requiring attention.');
  });

  // T-03-02: non-numeric id returns 400
  it('GET /activity/:id with a non-numeric id returns 400', async () => {
    const cookie = await login();

    const res = await server.inject({
      method: 'GET',
      url: '/activity/abc',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(400);
    // WR-06: HTML error page, not a JSON blob
    expect(res.body as string).toContain('<html');
    expect(res.body as string).not.toContain('{"error"');
  });

  // Detail 404 on unknown id
  it('GET /activity/:id for an unknown id returns 404', async () => {
    const cookie = await login();

    const res = await server.inject({
      method: 'GET',
      url: '/activity/99999',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
    // WR-06: HTML error page, not a JSON blob
    expect(res.body as string).toContain('<html');
    expect(res.body as string).not.toContain('{"error"');
  });

  // -------------------------------------------------------------------------
  // DACT-04: re-trigger
  // -------------------------------------------------------------------------

  it('POST /activity/:id/retrigger with a valid CSRF token calls enqueue with the reconstructed JobPayload', async () => {
    const cookie = await login();

    const id = insertReviewRun({
      prId: 'testorg/testrepo#42',
      owner: 'testorg',
      repo: 'testrepo',
      prNumber: 42,
      headSha: 'headaabbccdd',
      baseSha: 'baseeeff0011',
      installationId: 12345,
    });

    // Fetch CSRF from /activity (per plan contract)
    const csrf = await getAuthCsrf(cookie);

    const res = await server.inject({
      method: 'POST',
      url: `/activity/${id}/retrigger`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
      },
      payload: `_csrf=${encodeURIComponent(csrf)}`,
    });

    // Should succeed with an htmx client-side redirect (WR-04/WR-05)
    expect([200, 204, 302]).toContain(res.statusCode);
    if (res.statusCode === 204) {
      expect(res.headers['hx-redirect']).toBe('/activity');
    }

    // Enqueue must have been called exactly once
    expect(enqueueCalls).toHaveLength(1);
    expect(enqueueCalls[0]!.prId).toBe('testorg/testrepo#42');

    // Payload must reconstruct the original JobPayload
    const parsed = JSON.parse(enqueueCalls[0]!.payload) as {
      owner: string;
      repo: string;
      prNumber: number;
      headSha: string;
      baseSha: string;
      installationId?: number;
    };

    expect(parsed).toEqual({
      owner: 'testorg',
      repo: 'testrepo',
      prNumber: 42,
      headSha: 'headaabbccdd',
      baseSha: 'baseeeff0011',
      installationId: 12345,
    });
  });

  // T-03-01: CSRF rejection -- no enqueue
  it('POST /activity/:id/retrigger without a CSRF token returns 403 and does NOT call enqueue', async () => {
    const cookie = await login();

    const id = insertReviewRun();

    const res = await server.inject({
      method: 'POST',
      url: `/activity/${id}/retrigger`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
      },
      // No _csrf field
      payload: '',
    });

    expect(res.statusCode).toBe(403);
    expect(enqueueCalls).toHaveLength(0);
  });

  // Re-trigger 404 unknown id
  it('POST /activity/:id/retrigger for an unknown id returns 404 and does not call enqueue', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    const res = await server.inject({
      method: 'POST',
      url: '/activity/99999/retrigger',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
      },
      payload: `_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(res.statusCode).toBe(404);
    expect(enqueueCalls).toHaveLength(0);
  });

  // DACT-04 + JobPayload optionality: PAT mode omits installationId
  it('POST /activity/:id/retrigger omits installationId from the payload when the stored row has installation_id NULL', async () => {
    const cookie = await login();

    // Insert a PAT-mode row (installation_id null)
    const id = insertReviewRun({
      prId: 'myorg/myrepo#10',
      owner: 'myorg',
      repo: 'myrepo',
      prNumber: 10,
      headSha: 'sha1234',
      baseSha: 'base5678',
      installationId: null,
    });

    const csrf = await getAuthCsrf(cookie);

    const res = await server.inject({
      method: 'POST',
      url: `/activity/${id}/retrigger`,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie,
      },
      payload: `_csrf=${encodeURIComponent(csrf)}`,
    });

    expect([200, 204, 302]).toContain(res.statusCode);
    expect(enqueueCalls).toHaveLength(1);

    const parsed = JSON.parse(enqueueCalls[0]!.payload) as Record<string, unknown>;
    // installationId must be absent (or undefined) in PAT mode
    expect(parsed['installationId']).toBeUndefined();
    expect('installationId' in parsed).toBe(false);
  });
});
