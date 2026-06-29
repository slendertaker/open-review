/**
 * Repositories section route (DCFG-03, DCFG-05).
 *
 * Fills the body of the registerReposRoutes stub created by Plan 02.
 * Already imported and called by routes.ts -- do NOT modify routes.ts.
 *
 * POST /dashboard/repos
 *   - Auth: requireLogin (preHandler) + csrfProtection (preHandler)
 *   - Validates: owner/repo format (single slash, non-empty owner and repo)
 *   - On success: appends to allowlist, persists via setSetting, re-renders repos partial
 *   - On format error: re-renders with format error flash; no mutation
 *   - On duplicate: re-renders with duplicate error flash; no mutation
 *
 * DELETE /dashboard/repos/:repo
 *   - Auth: requireLogin (preHandler) + csrfProtection (preHandler)
 *   - Removes entry from allowlist, persists, re-renders repos partial
 *   - hx-target="closest [data-repo-row]" hx-swap="outerHTML" (swaps only the row)
 */

import type Database from 'better-sqlite3';
import type { ConfigStore } from '../config/store.js';
import { setSetting } from '../state/config-state.js';
import { renderFlash } from './partials.js';
import { requireLogin } from './auth.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFastify = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rep = any;

/** Validate owner/repo format: exactly one slash, non-empty owner and repo. */
function isValidRepo(value: string): boolean {
  const parts = value.trim().split('/');
  return (
    parts.length === 2 &&
    parts[0]!.length > 0 &&
    parts[1]!.length > 0
  );
}

/** Persist the repos array to the settings table as a JSON array. */
function persistRepos(repos: string[]): void {
  setSetting('repos', JSON.stringify(repos));
}

export async function registerReposRoutes(
  fastify: AnyFastify,
  store: ConfigStore,
  _db: Database.Database,
): Promise<void> {
  // -------------------------------------------------------------------------
  // POST /dashboard/repos -- add a repo to the allowlist
  // -------------------------------------------------------------------------
  fastify.post(
    '/dashboard/repos',
    { preHandler: [requireLogin, fastify.csrfProtection] },
    async (req: Req, reply: Rep) => {
      const body = req.body as Record<string, string | undefined>;
      const raw = (body['repo'] ?? '').trim();

      if (!isValidRepo(raw)) {
        const flash = renderFlash(
          'error',
          'Enter a repository as owner/repo (example: octocat/hello-world).',
        );
        const csrfToken = await reply.generateCsrf();
        return reply.code(200).viewAsync('dashboard/partials/repos', {
          repos: store.repos,
          csrfToken,
          flash,
        });
      }

      const current = store.repos;
      if (current.includes(raw)) {
        const flash = renderFlash('error', 'That repository is already in the allowlist.');
        const csrfToken = await reply.generateCsrf();
        return reply.code(200).viewAsync('dashboard/partials/repos', {
          repos: current,
          csrfToken,
          flash,
        });
      }

      const updated = [...current, raw];
      persistRepos(updated);

      const csrfToken = await reply.generateCsrf();
      const flash = renderFlash('success', 'Repository added.');
      return reply.code(200).viewAsync('dashboard/partials/repos', {
        repos: store.repos,
        csrfToken,
        flash,
      });
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /dashboard/repos/:repo -- remove a repo from the allowlist
  // -------------------------------------------------------------------------
  fastify.delete(
    '/dashboard/repos/:repo',
    { preHandler: [requireLogin, fastify.csrfProtection] },
    async (req: Req, reply: Rep) => {
      const params = req.params as { repo: string };
      // URL-decode in case the repo param is percent-encoded (e.g., owner%2Frepo).
      const target = decodeURIComponent(params['repo'] ?? '');

      const current = store.repos;
      const updated = current.filter((r) => r !== target);
      persistRepos(updated);

      // Re-render the whole repos partial after remove.
      // (Per UI-SPEC the remove button targets the row, but re-rendering the
      // whole section keeps the empty-state correct without extra complexity.)
      const csrfToken = await reply.generateCsrf();
      return reply.code(200).viewAsync('dashboard/partials/repos', {
        repos: store.repos,
        csrfToken,
        flash: '',
      });
    },
  );
}
