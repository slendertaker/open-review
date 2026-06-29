/**
 * Caddy integration helpers: render Caddyfile text, reload via admin API, and
 * apply a domain change to both the on-disk config and the running Caddy.
 *
 * Uses Node 22 global fetch -- no new npm dependency.
 */

import { writeFile } from 'node:fs/promises';

/**
 * Render a Caddyfile for the given domain and port.
 *
 * Domain present  -> ACME HTTPS site block (Caddy auto-provisions TLS).
 * Domain absent   -> plain HTTP :80 block (IP-only fallback).
 *
 * The output structure mirrors deploy/Caddyfile.tmpl so installer-time and
 * runtime configs are identical.
 */
export function renderCaddyfile(domain: string | undefined, port: number): string {
  if (domain && domain.length > 0) {
    return `${domain} {\n    reverse_proxy 127.0.0.1:${port}\n}\n`;
  }
  return `:80 {\n    reverse_proxy 127.0.0.1:${port}\n}\n`;
}

/**
 * POST the Caddyfile text to the Caddy admin API.
 *
 * Caddy adapts the raw Caddyfile server-side; no local `caddy adapt` step
 * needed. Throws on any non-2xx response so the caller can catch and flash.
 */
export async function reloadCaddy(caddyfileText: string): Promise<void> {
  const res = await fetch('http://127.0.0.1:2019/load', {
    method: 'POST',
    headers: { 'Content-Type': 'text/caddyfile' },
    body: caddyfileText,
  });
  if (!res.ok) {
    throw new Error(`Caddy reload failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Render the Caddyfile from the current domain/port, write it to disk, then
 * apply it to the running Caddy via the admin API.
 *
 * Write-then-load order ensures the on-disk config and the running config stay
 * in sync: a Caddy restart after /load (which would revert to the on-disk
 * Caddyfile) will see the already-updated file.
 *
 * @param domain       The bare hostname, or undefined/empty for IP-only mode.
 * @param port         The port the app is listening on.
 * @param caddyfilePath  Override the Caddyfile path (default /etc/caddy/Caddyfile).
 *                     Overridable so tests can target a temp path without root.
 */
export async function applyDomain(
  domain: string | undefined,
  port: number,
  caddyfilePath: string = '/etc/caddy/Caddyfile',
): Promise<void> {
  const text = renderCaddyfile(domain, port);
  await writeFile(caddyfilePath, text, 'utf8');
  await reloadCaddy(text);
}
