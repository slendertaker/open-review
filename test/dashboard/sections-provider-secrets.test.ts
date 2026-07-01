/**
 * Provider and Secrets section route tests (DCFG-02, DCFG-04, DCFG-05) -- Plan 04.
 *
 * Covers:
 *   Task 1 -- Provider section: POST /dashboard/settings/provider save + validation
 *             getProvider(store.provider) wiring
 *   Task 2 -- Secrets section: POST /dashboard/settings/secrets write-only masked fields
 *             no-plaintext guarantee, blank-preserves, secret-to-subprocess wiring
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
import { setSetting, setSecretRecord } from '../../src/state/config-state.js';
import { lockoutMap } from '../../src/dashboard/auth.js';
import { getProvider } from '../../src/provider/index.js';
import { encryptSecret, maskSecret } from '../../src/config/crypto.js';

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
// Provider section tests (Task 1)
// ---------------------------------------------------------------------------

describe('Provider section (DCFG-04) -- Plan 04 Task 1', () => {
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
    server = await buildServer(store, db, () => {}, makeKey());
    lockoutMap.clear();
  });

  afterEach(async () => {
    await server.close();
    lockoutMap.clear();
  });

  it('POST /dashboard/settings/provider with provider=claude saves and re-renders provider partial', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/provider',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `provider=claude&_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('provider-section');
    expect(res.body).toContain('Provider saved.');
    expect(store.provider).toBe('claude');
  });

  it('POST /dashboard/settings/provider with provider=codex is rejected and does not change stored provider', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    // Set provider to claude first
    setSetting('provider', 'claude');

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/provider',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `provider=codex&_csrf=${encodeURIComponent(csrf)}`,
    });

    // Should still return the partial (200) but provider unchanged
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('provider-section');
    // Must not contain success flash
    expect(res.body).not.toContain('Provider saved.');
    // Provider unchanged
    expect(store.provider).toBe('claude');
  });

  it('provider.eta renders Claude as active and Codex as disabled with [not available yet] badge', async () => {
    const cookie = await login();
    const res = await server.inject({
      method: 'GET',
      url: '/settings/provider',
      headers: { cookie },
    });

    expect(res.body).toContain('Claude Code');
    expect(res.body).toContain('[not available yet]');
    expect(res.body).toContain('OpenAI Codex');
    expect(res.body).toContain('Coming in a future release.');
  });

  it('POST /dashboard/settings/provider requires authentication', async () => {
    const getRes = await server.inject({ method: 'GET', url: '/login' });
    const csrf = extractCsrf(getRes.body as string);

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/provider',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(getRes) },
      payload: `provider=claude&_csrf=${encodeURIComponent(csrf)}`,
    });

    // Unauthenticated -- should redirect to login
    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toContain('/login');
  });

  it('POST /dashboard/settings/provider requires CSRF token', async () => {
    const cookie = await login();

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/provider',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: 'provider=claude',
    });

    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// getProvider dispatch tests (Task 1)
// ---------------------------------------------------------------------------

describe('getProvider dispatch (DCFG-04) -- Plan 04 Task 1', () => {
  it('getProvider("claude") returns a ClaudeProvider', () => {
    const provider = getProvider('claude');
    expect(provider).toBeDefined();
    expect(typeof provider.invoke).toBe('function');
    expect(typeof provider.parseOutput).toBe('function');
  });

  it('getProvider("codex") throws -- Codex is not yet implemented', () => {
    expect(() => getProvider('codex')).toThrow(/Unknown review provider.*codex/i);
  });

  it('getProvider with default argument returns claude provider', () => {
    const provider = getProvider();
    expect(provider).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Secrets section tests (Task 2)
// ---------------------------------------------------------------------------

describe('Secrets section (DCFG-02, DCFG-05) -- Plan 04 Task 2', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let server: any;
  let store: SqliteConfigStore;
  const KEY = makeKey();

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
    const res = await server.inject({
      method: 'GET',
      url: '/settings/general',
      headers: { cookie },
    });
    return extractCsrf(res.body as string);
  }

  beforeEach(async () => {
    const db = openDb(':memory:');
    store = new SqliteConfigStore(db, KEY);
    const hash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    setSetting('password_hash', hash);
    server = await buildServer(store, db, () => {}, KEY);
    lockoutMap.clear();
  });

  afterEach(async () => {
    await server.close();
    lockoutMap.clear();
  });

  it('POST /dashboard/settings/secrets response contains NO plaintext secret values', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);
    const oauthToken = 'myOauthToken-abcdefghijklmn-0123456789';

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/secrets',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `claudeOauthToken=${encodeURIComponent(oauthToken)}&_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(res.statusCode).toBe(200);
    // Response must NOT contain the raw token value
    expect(res.body).not.toContain(oauthToken);
    // But it must contain the masked preview
    const masked = maskSecret(oauthToken);
    expect(res.body).toContain(masked);
  });

  it('blank submit for secret field leaves encrypted value unchanged', async () => {
    // Pre-store an encrypted Claude OAuth token
    const originalToken = 'sk-ant-original-oauth-token-test-1234';
    const encrypted = encryptSecret(originalToken, KEY);
    setSecretRecord('claude_oauth_token', encrypted);

    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    // Submit with blank claudeOauthToken
    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/secrets',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `claudeOauthToken=&_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(res.statusCode).toBe(200);
    // The store getter should still decrypt to the original value
    expect(store.claudeOauthToken).toBe(originalToken);
  });

  it('rendered secret inputs have NO value attribute with secret content', async () => {
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);
    const secretValue = 'render-test-secret-value-9999';

    // First set a secret
    await server.inject({
      method: 'POST',
      url: '/dashboard/settings/secrets',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `claudeOauthToken=${encodeURIComponent(secretValue)}&_csrf=${encodeURIComponent(csrf)}`,
    });

    // Get a fresh CSRF and re-render the dashboard
    const csrf2 = await getAuthCsrf(cookie);

    // Re-fetch to verify the rendered partial has no value attribute containing the secret
    const dashboardRes = await server.inject({
      method: 'GET',
      url: '/settings/general',
      headers: { cookie },
    });

    // The secret value itself should never appear in the HTML
    expect(dashboardRes.body).not.toContain(secretValue);

    // No input should have the secret as a value attribute
    expect(dashboardRes.body).not.toMatch(new RegExp(`value="${secretValue}"`));
    void csrf2;
  });

  it('secrets section renders masked preview for set Anthropic API key', async () => {
    const apiKey = 'sk-ant-api03-testkey-abcdefgh';
    const encrypted = encryptSecret(apiKey, KEY);
    setSecretRecord('anthropic_api_key', encrypted);

    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/secrets',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `anthropicApiKey=&_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(res.statusCode).toBe(200);
    // Should show the masked preview for the API key (prefix-aware)
    const masked = maskSecret(apiKey, 'sk-ant-');
    expect(res.body).toContain(masked);
    // Should not contain plaintext
    expect(res.body).not.toContain(apiKey);
  });

  it('POST /dashboard/settings/secrets requires authentication', async () => {
    const getRes = await server.inject({ method: 'GET', url: '/login' });
    const csrf = extractCsrf(getRes.body as string);

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/secrets',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(getRes) },
      payload: `webhookSecret=test&_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toContain('/login');
  });

  it('POST /dashboard/settings/secrets requires CSRF token', async () => {
    const cookie = await login();

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/secrets',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: 'webhookSecret=test',
    });

    expect(res.statusCode).toBe(403);
  });

  it('save strips internal whitespace from claudeOauthToken (T-jr6-03)', async () => {
    // Simulate the live corruption: a token with two internal spaces injected mid-string.
    const baseToken = 'sk-ant-oauthTOKENabcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJK';
    const corruptedToken = baseToken.slice(0, 79) + '  ' + baseToken.slice(79);
    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/secrets',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `claudeOauthToken=${encodeURIComponent(corruptedToken)}&_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(res.statusCode).toBe(200);
    // The stored value must have all whitespace removed
    const stored = store.claudeOauthToken;
    expect(stored).toBe(corruptedToken.replace(/\s+/g, ''));
    // Sanity: the corruption was actually present in the input
    expect(corruptedToken).toContain('  ');
    // And is gone from the stored value
    expect(stored).not.toContain(' ');
  });

  it('blank submit still preserves the existing token after whitespace-stripping change (T-jr6-03)', async () => {
    // Pre-store a token directly (no whitespace -- already clean)
    const originalToken = 'sk-ant-original-clean-token-abcdefgh1234';
    setSecretRecord('claude_oauth_token', encryptSecret(originalToken, KEY));

    const cookie = await login();
    const csrf = await getAuthCsrf(cookie);

    // Submit with blank claudeOauthToken -- should preserve the existing stored value
    const res = await server.inject({
      method: 'POST',
      url: '/dashboard/settings/secrets',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      payload: `claudeOauthToken=&_csrf=${encodeURIComponent(csrf)}`,
    });

    expect(res.statusCode).toBe(200);
    // The store getter must still decrypt to the original value
    expect(store.claudeOauthToken).toBe(originalToken);
  });

});

// ---------------------------------------------------------------------------
// maskSecret helper unit tests
// ---------------------------------------------------------------------------

describe('maskSecret helper (DCFG-02)', () => {
  it('masks default token format: 4 bullets + last 4 chars', () => {
    const result = maskSecret('abcdefgh1234');
    expect(result).toBe('••••1234');
  });

  it('masks with prefix: prefix + 4 bullets + last 4', () => {
    const result = maskSecret('sk-ant-api03-abcdefgh1234', 'sk-ant-');
    expect(result).toBe('sk-ant-••••1234');
  });

  it('masks PAT with ghp_ prefix', () => {
    const result = maskSecret('ghp_sometoken9876', 'ghp_');
    expect(result).toBe('ghp_••••9876');
  });
});
