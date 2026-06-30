/**
 * QA-02: Accessibility source-text assertions over dashboard.css and auth templates.
 *
 * Asserts that the accessibility affordances shipped in Phases 6 and 8 are
 * present in source without requiring a browser or axe-core. Seven targeted
 * substring checks cover the focus ring, reduced-motion media queries, ARIA
 * alert roles, and autocomplete tokens (D-08).
 *
 * Files read at module scope -- all three paths are known to exist.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CSS = readFileSync(path.join(ROOT, 'public/styles/dashboard.css'), 'utf8');
const LOGIN = readFileSync(path.join(ROOT, 'views/login.eta'), 'utf8');
const SETUP = readFileSync(path.join(ROOT, 'views/setup.eta'), 'utf8');

describe('QA-02 accessibility gates', () => {
  it('dashboard.css contains :focus-visible rule on buttons', () => {
    expect(CSS).toContain(':focus-visible');
  });

  it('dashboard.css contains prefers-reduced-motion: reduce block', () => {
    expect(CSS).toContain('prefers-reduced-motion: reduce');
  });

  it('dashboard.css contains prefers-reduced-motion: no-preference block', () => {
    expect(CSS).toContain('prefers-reduced-motion: no-preference');
  });

  it('login.eta flash element carries role="alert"', () => {
    expect(LOGIN).toContain('role="alert"');
  });

  it('setup.eta flash elements carry role="alert"', () => {
    expect(SETUP).toContain('role="alert"');
  });

  it('login.eta password field has autocomplete="current-password"', () => {
    expect(LOGIN).toContain('autocomplete="current-password"');
  });

  it('setup.eta password fields have autocomplete="new-password"', () => {
    expect(SETUP).toContain('autocomplete="new-password"');
  });
});
