/**
 * Unit tests for renderCaddyfile and reloadCaddy in src/dashboard/caddy.ts.
 *
 * applyDomain is NOT unit-tested here: it writes /etc/caddy/Caddyfile (root path)
 * and is validated on the VPS at verify time. reloadCaddy IS tested with a mocked
 * fetch to guard the Caddy admin-API contract (notably the required Origin header).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderCaddyfile, reloadCaddy } from '../../src/dashboard/caddy.js';

// Reference the em-dash glyph via a constant so this test file cannot flag
// itself in any future em-dash scan.
const EM_DASH = '—';

describe('renderCaddyfile', () => {
  it('domain mode: contains the domain and reverse_proxy with the correct port', () => {
    const out = renderCaddyfile('review.example.com', 3000);
    expect(out).toContain('review.example.com');
    expect(out).toContain('reverse_proxy 127.0.0.1:3000');
  });

  it('domain mode: produces a site-block with the domain as the address', () => {
    const out = renderCaddyfile('review.example.com', 3000);
    // The domain must be the site address (first token on its line or block open).
    expect(out.trimStart().startsWith('review.example.com')).toBe(true);
  });

  it('IP-only mode (undefined): produces :80 block with correct port', () => {
    const out = renderCaddyfile(undefined, 3000);
    expect(out).toContain(':80');
    expect(out).toContain('reverse_proxy 127.0.0.1:3000');
  });

  it('IP-only mode (undefined): does not contain a bare domain site address', () => {
    const out = renderCaddyfile(undefined, 3000);
    // Should not contain any hostname-looking line (letters.letters pattern without a colon).
    // The only address should be :80.
    expect(out).not.toMatch(/^[a-zA-Z][a-zA-Z0-9.-]+\s*\{/m);
  });

  it('IP-only mode (empty string): treated the same as undefined', () => {
    const out = renderCaddyfile('', 3000);
    expect(out).toContain(':80');
    expect(out).toContain('reverse_proxy 127.0.0.1:3000');
  });

  it('rendered text contains no em-dash (U+2014)', () => {
    const domainOut = renderCaddyfile('review.example.com', 3000);
    const ipOut = renderCaddyfile(undefined, 3000);
    expect(domainOut).not.toContain(EM_DASH);
    expect(ipOut).not.toContain(EM_DASH);
  });

  it('port is interpolated correctly for non-default ports', () => {
    const out = renderCaddyfile('example.com', 8080);
    expect(out).toContain('reverse_proxy 127.0.0.1:8080');
  });
});

describe('reloadCaddy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('POSTs to the admin /load endpoint with an Origin header (Caddy rejects an empty Origin with 403)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    await reloadCaddy(':80 {\n    reverse_proxy 127.0.0.1:3000\n}\n');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:2019/load');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('text/caddyfile');
    // The Origin header is the fix: without it Caddy's admin API returns 403.
    expect(headers.Origin).toBe('http://127.0.0.1:2019');
  });

  it('throws when Caddy returns a non-2xx status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"error":"client is not allowed to access from origin \'\'"}',
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(reloadCaddy(':80 {\n}\n')).rejects.toThrow(/403/);
  });
});
