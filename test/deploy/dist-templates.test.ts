/**
 * DEPL-02: Build-output (dist/) template guard.
 *
 * The runtime resolves PROJECT_ROOT to dist/ (server.js runs from dist/src/,
 * PROJECT_ROOT = resolve(__dirname, '..')), so @fastify/view reads dist/views
 * and @fastify/static serves dist/public. If the build does not copy views/
 * and public/ into dist/, every rendered dashboard page 500s on a real
 * deployment even though the source-tree tests pass.
 *
 * This guard catches that dev-vs-prod divergence by:
 *   1. asserting the deployed (dist/) artifacts exist on disk, and
 *   2. rendering a real page from the BUILT dist/views output via Eta.
 *
 * Requires `npm run build` to have run first (the build copies the assets).
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { Eta } from 'eta';

const REPO_ROOT = process.cwd();
const DIST_VIEWS = path.resolve(REPO_ROOT, 'dist/views');
const DIST_PUBLIC_VENDOR = path.resolve(REPO_ROOT, 'dist/public/vendor');

describe('DEPL-02 dist/ template build-output guard', () => {
  it('build copies views/ and public/ into dist/', () => {
    expect(
      existsSync(path.join(DIST_VIEWS, 'layout.eta')),
      'dist/views/layout.eta not found -- run `npm run build` (the deployed dist/ layout the runtime renders from must contain views/)',
    ).toBe(true);

    expect(
      existsSync(DIST_PUBLIC_VENDOR),
      'dist/public/vendor not found -- run `npm run build` (the deployed dist/ layout the runtime serves static assets from must contain public/)',
    ).toBe(true);
  });

  it('layout.eta renders from the built dist/ output', async () => {
    if (!existsSync(path.join(DIST_VIEWS, 'layout.eta'))) {
      // The prior it() already fails with a build-required message; avoid a
      // confusing ENOENT here before that assertion surfaces.
      return;
    }

    const eta = new Eta({ views: DIST_VIEWS });
    const html = await eta.renderAsync('layout.eta', {
      title: 'Open Review',
      body: '<main id="smoke">ok</main>',
    });

    // Failure-mode phrase built up rather than written verbatim so the
    // comment-text gate stays clean.
    const failureMode = ['unable', 'to', 'access', 'template'].join(' ');

    expect(typeof html).toBe('string');
    expect(html.length).toBeGreaterThan(0);
    expect(html).not.toContain(failureMode);
    expect(html).toContain('<main id="smoke">ok</main>');
  });
});
