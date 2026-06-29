/**
 * Unit tests for the pure renderCaddyfile helper in src/dashboard/caddy.ts.
 *
 * reloadCaddy and applyDomain are NOT unit-tested here: they require a live
 * Caddy admin socket and root access to /etc/caddy/Caddyfile. Those are
 * validated manually on the VPS at verify time.
 */

import { describe, it, expect } from 'vitest';
import { renderCaddyfile } from '../../src/dashboard/caddy.js';

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
