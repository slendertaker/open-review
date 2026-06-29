/**
 * Flash message and htmx partial response helpers (BRND-01).
 *
 * renderFlash: produces the UI-SPEC flash markup with [+]/[x]/[!] prefix
 * and the correct color class. Used in Eta partials to render save results.
 *
 * These helpers produce raw HTML strings safe to embed via <%~ %> in Eta
 * templates (the <%~ %> tag is NOT auto-escaped -- use only for known-safe
 * fragments built server-side from literal strings, never from user input).
 */

export type FlashKind = 'success' | 'error' | 'warning';

interface FlashOptions {
  /** Optional: prefix override. Defaults to [+] success, [x] error, [!] warning. */
  prefix?: string;
  /** Optional: auto-dismiss after N ms via Alpine.js. 0 = no auto-dismiss. */
  autoDismissMs?: number;
}

/**
 * Build a flash message HTML fragment per UI-SPEC §Shared Component Contracts.
 *
 * Auto-dismiss via Alpine.js when autoDismissMs > 0.
 * Returns raw HTML -- only embed via <%~ %> in Eta templates.
 */
export function renderFlash(
  kind: FlashKind,
  message: string,
  options: FlashOptions = {},
): string {
  const prefix = options.prefix ?? (kind === 'success' ? '[+]' : kind === 'error' ? '[x]' : '[!]');
  const cssClass = `flash-${kind}`;
  const autoDismissMs = options.autoDismissMs ?? (kind === 'success' ? 3000 : 0);

  const alpineAttrs =
    autoDismissMs > 0
      ? ` x-data="{ show: true }" x-show="show" x-init="setTimeout(() => show = false, ${autoDismissMs})"`
      : '';

  // Escape message to prevent XSS (message comes from server-controlled strings,
  // but we apply escaping defensively).
  const safeMsg = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return `<p class="${cssClass}" role="alert"${alpineAttrs}>${prefix} ${safeMsg}</p>`;
}

/**
 * Build an htmx section partial wrapper for Wave 2 section route responses.
 * The content string should be the inner HTML of the section (already rendered).
 * Returns raw HTML -- only embed via <%~ %> in Eta templates.
 */
export function sectionPartial(sectionId: string, content: string): string {
  return `<div id="${sectionId}">${content}</div>`;
}
