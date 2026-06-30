/**
 * Health sub-page routes (NAV-03, NAV-04, D-06).
 *
 * GET /settings/health/partial -- bare health fragment for self-contained 10s poll.
 * GET /settings/health          -- hybrid: full shell on direct load, bare section fragment on HX-Request.
 *
 * Reuses computeHealthData from health.ts (the existing aggregation module).
 * The self-poll endpoint returns bare health.eta so htmx replaces the inner
 * content of #health-content without nesting a second poller; the full/fragment
 * paths return health-section.eta (with the #health-content poller wrapper).
 */

import type Database from 'better-sqlite3';
import type { ConfigStore } from '../config/store.js';
import { computeHealthData } from './health.js';
import { requireLogin } from './auth.js';
import { viewGlobals } from './routes.js';
import { getSetting } from '../state/config-state.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFastify = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rep = any;

export async function registerHealthRoutes(
  fastify: AnyFastify,
  store: ConfigStore,
  db: Database.Database,
): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /settings/health/partial -- bare health fragment for self-contained poll
  // No CSRF needed: health.eta has no forms.
  // T-07-04: requireLogin guards this endpoint.
  // -------------------------------------------------------------------------
  fastify.get('/settings/health/partial', { preHandler: requireLogin }, async (_req: Req, reply: Rep) => {
    const health = await computeHealthData(db, store);
    return reply.viewAsync('dashboard/partials/health', { health });
  });

  // -------------------------------------------------------------------------
  // GET /settings/health -- hybrid: fragment (HX-Request) or full shell
  // T-07-04: requireLogin guards this endpoint.
  // -------------------------------------------------------------------------
  fastify.get('/settings/health', { preHandler: requireLogin }, async (req: Req, reply: Rep) => {
    const csrfToken = await reply.generateCsrf(); // ALWAYS first, both paths (D-07, consistency)
    const health = await computeHealthData(db, store);

    const isHtmx = req.headers['hx-request'] === 'true'
      && req.headers['hx-history-restore-request'] !== 'true';

    if (isHtmx) {
      return reply.code(200).viewAsync('dashboard/partials/health-section', { health, csrfToken });
    }

    // Full-shell path: pre-render partials to strings then render the shell.
    const sectionContent = await (fastify.view as (page: string, data: unknown) => Promise<string>)(
      'dashboard/partials/health-section',
      { health, csrfToken },
    );
    const sidebarContext = await (fastify.view as (page: string, data: unknown) => Promise<string>)(
      'dashboard/partials/sidebar-context',
      {
        github_app_slug: getSetting('github_app_slug'),
        github_app_name: getSetting('github_app_name'),
        repos: store.repos,
      },
    );

    return reply.viewAsync('shell', {
      ...viewGlobals(req),
      title: 'Health - Open Review',
      activeSection: 'health',
      sectionContent,
      sidebarContext,
      csrfToken,
    }, { layout: 'layout.eta' });
  });
}
