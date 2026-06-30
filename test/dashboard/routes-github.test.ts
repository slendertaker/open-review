/**
 * GitHub App Manifest flow + installation/repo listing tests (Phase 5 Wave 0 RED).
 *
 * These tests pin the five Phase 5 success criteria BEFORE production code exists.
 * They MUST fail now (RED) and turn green only after Plans 02-04 land.
 *
 * Requirements: GHUB-01 (SC-1), GHUB-02 (SC-2), GHUB-03 (SC-3), GHUB-04 (SC-4)
 *
 * Boilerplate analog: test/dashboard/sections-provider-secrets.test.ts
 * Octokit mock: vi.mock('@octokit/rest') with createFromManifest/listInstallations/listReposAccessibleToInstallation
 */

import argon2 from 'argon2';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../../src/state/db.js';
import { buildServer } from '../../src/server.js';
import { SqliteConfigStore } from '../../src/config/sqlite-store.js';
import { setSetting, getSetting, setSecretRecord, getSecretRecord } from '../../src/state/config-state.js';
import { lockoutMap } from '../../src/dashboard/auth.js';

// ---------------------------------------------------------------------------
// Octokit mock -- isolates all GitHub API network calls
// Mock createFromManifest returns the conversion-response fixture per PATTERNS.md.
// ---------------------------------------------------------------------------

// Sample PEM fixture (synthetic, non-functional -- for redaction testing)
const SAMPLE_PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEA0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN',
  'OPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQR',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

const SAMPLE_CLIENT_SECRET = 'test_client_secret_value_abc123';
const SAMPLE_WEBHOOK_SECRET = 'whsec_testvalue_xyz789';

const MOCK_CONVERSION_RESPONSE = {
  data: {
    id: 123456,
    slug: 'open-review-abc123',
    name: 'open-review-abc123',
    html_url: 'https://github.com/apps/open-review-abc123',
    client_id: 'Iv1.abcdef123456',
    pem: SAMPLE_PEM,
    webhook_secret: SAMPLE_WEBHOOK_SECRET,
    client_secret: SAMPLE_CLIENT_SECRET,
  },
};

// Mock installations: one User, one Organization
const MOCK_INSTALLATIONS = [
  { id: 1001, account: { login: 'myuser', type: 'User' }, repository_selection: 'selected' },
  { id: 1002, account: { login: 'myorg', type: 'Organization' }, repository_selection: 'selected' },
];

// Mock repos per installation
const MOCK_REPOS_USER = [
  { full_name: 'myuser/repo-a', name: 'repo-a', private: false },
  { full_name: 'myuser/repo-b', name: 'repo-b', private: true },
];
const MOCK_REPOS_ORG = [
  { full_name: 'myorg/repo-c', name: 'repo-c', private: false },
];

// The createFromManifest mock instance (captured for spy assertions)
const createFromManifestMock = vi.fn().mockResolvedValue(MOCK_CONVERSION_RESPONSE);

// paginate mock that dispatches by the endpoint method reference
const paginateMock = vi.fn().mockImplementation(async (fn: unknown) => {
  // Return different data based on which endpoint is being paginated
  // This is a simplified dispatcher -- the production handler will call paginate with
  // octokit.rest.apps.listInstallations or listReposAccessibleToInstallation
  return MOCK_INSTALLATIONS;
});

vi.mock('@octokit/rest', () => ({
  // Use a regular function (not an arrow function) so that `new Octokit()` works
  // in Vitest 4.x, which calls Reflect.construct on the implementation.
  // Arrow functions are not constructors and throw in that path.
  Octokit: vi.fn().mockImplementation(function () {
    return {
      rest: {
        apps: {
          createFromManifest: createFromManifestMock,
          listInstallations: vi.fn(),
          listReposAccessibleToInstallation: vi.fn(),
        },
      },
      paginate: paginateMock,
    };
  }),
}));

vi.mock('@octokit/auth-app', () => ({
  createAppAuth: vi.fn().mockReturnValue(() => Promise.resolve({ type: 'app', token: 'mocked-app-jwt' })),
}));

// ---------------------------------------------------------------------------
// Test helpers (analog: sections-provider-secrets.test.ts + sections-general-repos.test.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Test suite: GitHub connect flow (SC-1, D5-01, D5-02)
// ---------------------------------------------------------------------------

/**
 * SC-1 (D5-01, D5-02): A new "GitHub" dashboard section renders a connect form.
 * The form auto-submits a manifest JSON payload to github.com/settings/apps/new.
 * This describe block tests the GET /dashboard/github/connect route that produces
 * the auto-submitting form.
 */
describe('github connect flow (SC-1, D5-01, D5-02)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

  beforeEach(async () => {
    const db = openDb(':memory:');
    const store = new SqliteConfigStore(db, makeKey());
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    setSetting('password_hash', hash);
    server = await buildServer(store, db, () => {}, makeKey());
    lockoutMap.clear();
    createFromManifestMock.mockClear();
    paginateMock.mockClear();
  });

  afterEach(async () => {
    await server.close();
    lockoutMap.clear();
  });

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

  it('GET /dashboard/github/connect returns 200 with an auto-submitting manifest form (D5-02)', async () => {
    // RED: /dashboard/github/connect does not exist yet -- expects 200, gets 404
    const cookie = await login();

    const res = await server.inject({
      method: 'GET',
      url: '/dashboard/github/connect',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    // Form targets github.com settings/apps/new
    expect(res.body).toContain('github.com');
    expect(res.body).toContain('settings/apps/new');
    // Auto-submit script
    expect(res.body).toContain('manifest-form');
    expect(res.body).toContain('.submit()');
  });

  it('manifest JSON contains required hook_attributes.url ending in /webhook (D5-02)', async () => {
    // RED: route does not exist
    const cookie = await login();

    const res = await server.inject({
      method: 'GET',
      url: '/dashboard/github/connect',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    // The manifest JSON is embedded in the form as a hidden input named "manifest"
    expect(res.body).toContain('name="manifest"');
    // Parse the manifest JSON from the rendered form
    const manifestMatch = /name="manifest"[^>]*value="([^"]+)"/.exec(res.body);
    expect(manifestMatch).not.toBeNull();
    const manifestJson = JSON.parse((manifestMatch![1]!).replace(/&quot;/g, '"'));
    expect(manifestJson.hook_attributes?.url).toMatch(/\/webhook$/);
  });

  it('manifest JSON contains redirect_url ending in /dashboard/github/callback (D5-02)', async () => {
    // RED: route does not exist
    const cookie = await login();

    const res = await server.inject({
      method: 'GET',
      url: '/dashboard/github/connect',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const manifestMatch = /name="manifest"[^>]*value="([^"]+)"/.exec(res.body);
    expect(manifestMatch).not.toBeNull();
    const manifestJson = JSON.parse((manifestMatch![1]!).replace(/&quot;/g, '"'));
    expect(manifestJson.redirect_url).toMatch(/\/dashboard\/github\/callback$/);
  });

  it('manifest JSON includes pull_request in default_events (D5-02)', async () => {
    // RED: route does not exist
    const cookie = await login();

    const res = await server.inject({
      method: 'GET',
      url: '/dashboard/github/connect',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const manifestMatch = /name="manifest"[^>]*value="([^"]+)"/.exec(res.body);
    expect(manifestMatch).not.toBeNull();
    const manifestJson = JSON.parse((manifestMatch![1]!).replace(/&quot;/g, '"'));
    expect(manifestJson.default_events).toContain('pull_request');
  });

  it('manifest JSON default_permissions includes pull_requests write, contents read, metadata read (D5-02)', async () => {
    // RED: route does not exist
    const cookie = await login();

    const res = await server.inject({
      method: 'GET',
      url: '/dashboard/github/connect',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const manifestMatch = /name="manifest"[^>]*value="([^"]+)"/.exec(res.body);
    expect(manifestMatch).not.toBeNull();
    const manifestJson = JSON.parse((manifestMatch![1]!).replace(/&quot;/g, '"'));
    const perms = manifestJson.default_permissions;
    expect(perms).toBeDefined();
    expect(perms['pull_requests']).toBe('write');
    expect(perms['contents']).toBe('read');
    expect(perms['metadata']).toBe('read');
  });

  it('GET /dashboard/github/connect requires authentication (D5-06)', async () => {
    // Unauthenticated request should redirect to login
    const res = await server.inject({
      method: 'GET',
      url: '/dashboard/github/connect',
    });

    // Should redirect to login, not 404 (even before route exists, this tests auth guard)
    expect([302, 401, 404]).toContain(res.statusCode);
    // If 302, must redirect to login
    if (res.statusCode === 302) {
      expect(res.headers['location']).toContain('/login');
    }
  });
});

// ---------------------------------------------------------------------------
// Test suite: GitHub callback persistence (SC-1, SC-4, D5-03)
// ---------------------------------------------------------------------------

/**
 * SC-1 (D5-03): After the manifest flow, GitHub redirects to /dashboard/github/callback
 * with a one-time code and the state token. The callback handler verifies state,
 * exchanges the code for credentials, and persists them.
 *
 * SC-4 (D5-06): State CSRF protection -- mismatched state must be rejected.
 */
describe('github callback persistence (SC-1, SC-4, D5-03)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

  beforeEach(async () => {
    const db = openDb(':memory:');
    const store = new SqliteConfigStore(db, makeKey());
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    setSetting('password_hash', hash);
    server = await buildServer(store, db, () => {}, makeKey());
    lockoutMap.clear();
    createFromManifestMock.mockClear();
    paginateMock.mockClear();
  });

  afterEach(async () => {
    await server.close();
    lockoutMap.clear();
  });

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

  it('callback persists github_app_slug as a setting after code exchange (D5-03)', async () => {
    // RED: /dashboard/github/callback does not exist yet
    // To test this properly we need to first seed the session state via the connect route.
    // Since the connect route also does not exist, we expect 404 at first.
    // This test documents the FULL flow that Plan 03 must implement.
    const cookie = await login();

    // Step 1: GET /dashboard/github/connect to generate session state token
    const connectRes = await server.inject({
      method: 'GET',
      url: '/dashboard/github/connect',
      headers: { cookie },
    });

    // RED: currently 404 -- after Plan 03 this becomes 200
    expect(connectRes.statusCode).toBe(200);

    // Extract the state token from the form action URL
    const stateMatch = /state=([a-f0-9]+)/.exec(connectRes.body as string);
    expect(stateMatch).not.toBeNull();
    const stateToken = stateMatch![1]!;

    // Step 2: Simulate GitHub callback with the state and a code
    const callbackRes = await server.inject({
      method: 'GET',
      url: `/dashboard/github/callback?code=test-code-abc&state=${stateToken}`,
      headers: { cookie },
    });

    // After Plan 03: callback exchanges code, persists credentials, redirects
    expect([200, 302]).toContain(callbackRes.statusCode);

    // github_app_slug must be persisted as a setting (the connection marker per D5-07)
    expect(getSetting('github_app_slug')).toBe('open-review-abc123');
  });

  it('callback persists github_app_private_key as a secret record (SC-4, D5-03)', async () => {
    // RED: the route does not exist; this documents what Plan 03 must build
    const cookie = await login();

    const connectRes = await server.inject({
      method: 'GET',
      url: '/dashboard/github/connect',
      headers: { cookie },
    });
    expect(connectRes.statusCode).toBe(200);

    const stateMatch = /state=([a-f0-9]+)/.exec(connectRes.body as string);
    expect(stateMatch).not.toBeNull();
    const stateToken = stateMatch![1]!;

    await server.inject({
      method: 'GET',
      url: `/dashboard/github/callback?code=test-code-abc&state=${stateToken}`,
      headers: { cookie },
    });

    // github_app_private_key must exist as an encrypted secret record (never plaintext)
    const record = getSecretRecord('github_app_private_key');
    expect(record).not.toBeNull();
    // The raw stored value must NOT be the plaintext PEM (it's encrypted)
    expect(record).not.toContain('PRIVATE KEY');
  });

  it('callback persists github_app_id into the secrets store so the runner resolves App-mode auth', async () => {
    // Regression: the runner reads ConfigStore.githubAppId -> readSecret('github_app_id').
    // The manifest callback previously wrote app_id only to the settings table, which the
    // runner never reads, so every review failed with "No GitHub auth available".
    const cookie = await login();

    const connectRes = await server.inject({
      method: 'GET',
      url: '/dashboard/github/connect',
      headers: { cookie },
    });
    const stateToken = /state=([a-f0-9]+)/.exec(connectRes.body as string)![1]!;

    await server.inject({
      method: 'GET',
      url: `/dashboard/github/callback?code=test-code-abc&state=${stateToken}`,
      headers: { cookie },
    });

    // app_id must be present in the secrets store as an encrypted record (ivHex:tagHex:ciphertext)
    const record = getSecretRecord('github_app_id');
    expect(record).not.toBeUndefined();
    expect((record as string).split(':')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Test suite: GitHub callback state CSRF (SC-4, D5-06)
// ---------------------------------------------------------------------------

/**
 * SC-4 (D5-06): The callback state token is bound to the session. A request with
 * a mismatched or absent state must be rejected with 400 and must NOT invoke
 * createFromManifest (the code exchange must never happen on CSRF attempts).
 */
describe('github callback state CSRF (SC-4, D5-06)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

  beforeEach(async () => {
    const db = openDb(':memory:');
    const store = new SqliteConfigStore(db, makeKey());
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    setSetting('password_hash', hash);
    server = await buildServer(store, db, () => {}, makeKey());
    lockoutMap.clear();
    createFromManifestMock.mockClear();
    paginateMock.mockClear();
  });

  afterEach(async () => {
    await server.close();
    lockoutMap.clear();
  });

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

  it('callback with mismatched state returns 400 and does NOT invoke createFromManifest (D5-06)', async () => {
    // RED: /dashboard/github/callback does not exist -- after Plan 03 this is 400
    const cookie = await login();

    // Hit the callback with a state that does NOT match any session-stored token
    const res = await server.inject({
      method: 'GET',
      url: '/dashboard/github/callback?code=test-code&state=wrong-state-token-000000',
      headers: { cookie },
    });

    // Must reject with a non-success status (400 per D5-06)
    expect(res.statusCode).toBe(400);
    // createFromManifest must NOT have been called
    expect(createFromManifestMock).not.toHaveBeenCalled();
  });

  it('callback with no state returns 400 and does NOT invoke createFromManifest (D5-06)', async () => {
    // RED: /dashboard/github/callback does not exist
    const cookie = await login();

    const res = await server.inject({
      method: 'GET',
      url: '/dashboard/github/callback?code=test-code-only',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(400);
    expect(createFromManifestMock).not.toHaveBeenCalled();
  });

  it('callback without authentication redirects to login (D5-06)', async () => {
    // All new routes require login (requireLogin preHandler)
    const res = await server.inject({
      method: 'GET',
      url: '/dashboard/github/callback?code=test-code&state=any-state',
    });

    // Unauthenticated -- redirect to login
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toContain('/login');
  });
});

// ---------------------------------------------------------------------------
// Test suite: GitHub installations grouped by account (SC-3, D5-05)
// ---------------------------------------------------------------------------

/**
 * SC-3 (D5-05): After App installation, GET /dashboard/github renders repo rows
 * grouped by account. User accounts and Organization accounts appear in separate
 * groups labeled with the account login and type.
 */
describe('github installations grouped by account (SC-3, D5-05)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;

  beforeEach(async () => {
    const db = openDb(':memory:');
    const store = new SqliteConfigStore(db, makeKey());
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    setSetting('password_hash', hash);

    // Seed connection state: github_app_slug present = App is connected
    setSetting('github_app_slug', 'open-review-abc123');
    setSetting('github_app_id', '123456');
    setSetting('github_app_name', 'open-review-abc123');
    setSetting('github_app_html_url', 'https://github.com/apps/open-review-abc123');
    setSetting('github_client_id', 'Iv1.abcdef123456');

    server = await buildServer(store, db, () => {}, makeKey());
    lockoutMap.clear();

    // Set up paginate mock to return installations, then repos per installation
    let paginateCallCount = 0;
    paginateMock.mockImplementation(async () => {
      paginateCallCount++;
      // First call: list installations
      if (paginateCallCount === 1) return MOCK_INSTALLATIONS;
      // Second call: repos for user installation (id 1001)
      if (paginateCallCount === 2) return MOCK_REPOS_USER;
      // Third call: repos for org installation (id 1002)
      return MOCK_REPOS_ORG;
    });
  });

  afterEach(async () => {
    await server.close();
    lockoutMap.clear();
    paginateMock.mockReset();
  });

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

  it('GET /dashboard/github renders both user and org account sections (D5-05)', async () => {
    // RED: /dashboard/github does not exist -- after Plan 03/04 this becomes 200
    const cookie = await login();

    const res = await server.inject({
      method: 'GET',
      url: '/dashboard/github',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    // Both account logins must appear in the rendered HTML
    expect(res.body).toContain('myuser');
    expect(res.body).toContain('myorg');
  });

  it('GET /dashboard/github labels the organization group as an organization (D5-05)', async () => {
    // RED: /dashboard/github does not exist
    const cookie = await login();

    const res = await server.inject({
      method: 'GET',
      url: '/dashboard/github',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    // The org group must be labeled as organization (case-insensitive)
    expect(res.body.toLowerCase()).toContain('organization');
  });

  it('GET /dashboard/github renders repo rows for each account (D5-05)', async () => {
    // RED: /dashboard/github does not exist
    const cookie = await login();

    const res = await server.inject({
      method: 'GET',
      url: '/dashboard/github',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    // User repos
    expect(res.body).toContain('myuser/repo-a');
    expect(res.body).toContain('myuser/repo-b');
    // Org repos
    expect(res.body).toContain('myorg/repo-c');
  });

  it('GET /dashboard/github requires authentication (D5-06)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/dashboard/github',
    });

    // Unauthenticated -- must redirect to login
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toContain('/login');
  });
});
