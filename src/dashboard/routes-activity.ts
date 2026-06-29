/**
 * Activity feed + detail + health + re-trigger routes (DACT-01..04).
 *
 * registerActivityRoutes is the single mount point for all /activity routes.
 * Called from registerDashboardRoutes in routes.ts (the single dashboard registrar).
 */

import type Database from 'better-sqlite3';
import type { ConfigStore } from '../config/store.js';
import { requireLogin } from './auth.js';
import {
  getReviewRunPage,
  getReviewRunById,
} from '../state/review-runs.js';
import { computeHealthData } from './health.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFastify = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rep = any;

const PAGE_SIZE = 50;

export async function registerActivityRoutes(
  fastify: AnyFastify,
  store: ConfigStore,
  db: Database.Database,
  _enqueue: (prId: string, payload: string) => void,
): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /activity -- full feed page (T-03-04: requires login)
  // -------------------------------------------------------------------------
  fastify.get('/activity', { preHandler: requireLogin }, async (req: Req, reply: Rep) => {
    const rawPage = req.query?.page as string | undefined;
    let page = parseInt(rawPage ?? '0', 10);
    if (!Number.isFinite(page) || page < 0) page = 0;

    const rows = getReviewRunPage(PAGE_SIZE, page * PAGE_SIZE);
    const health = await computeHealthData(db, store);
    const csrfToken = await reply.generateCsrf();

    return reply.viewAsync('dashboard/activity', {
      title: 'Activity - Open Review',
      csrfToken,
      rows,
      page,
      pageSize: PAGE_SIZE,
      health,
    });
  });

  // -------------------------------------------------------------------------
  // GET /activity/partial -- htmx partial (T-03-04: requires login)
  // Returns the feed rows partial + OOB health panel for 5s polling swaps.
  // -------------------------------------------------------------------------
  fastify.get('/activity/partial', { preHandler: requireLogin }, async (_req: Req, reply: Rep) => {
    const rows = getReviewRunPage(PAGE_SIZE, 0);
    const health = await computeHealthData(db, store);
    const csrfToken = await reply.generateCsrf();

    return reply.viewAsync('dashboard/partials/activity-list', {
      rows,
      page: 0,
      pageSize: PAGE_SIZE,
      csrfToken,
      health,
    });
  });

  // -------------------------------------------------------------------------
  // GET /activity/:id -- detail page (DACT-02)
  // -------------------------------------------------------------------------
  fastify.get('/activity/:id', { preHandler: requireLogin }, async (req: Req, reply: Rep) => {
    const rawId = (req.params as Record<string, string>)['id'];
    const id = parseInt(rawId ?? '', 10);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ error: 'Invalid review run id.' });
    }

    const run = getReviewRunById(id);
    if (!run) {
      return reply.code(404).send({ error: 'Review run not found.' });
    }

    // Parse findings_json in the handler (T-03-05: prevent XSS by rendering
    // individual fields via auto-escaped <%= %> instead of raw JSON string).
    let findings: Array<{ file: string; line: number; severity: string; message: string }> = [];
    try {
      findings = JSON.parse(run.findings_json) as typeof findings;
    } catch {
      findings = [];
    }

    const csrfToken = await reply.generateCsrf();

    return reply.viewAsync('dashboard/activity-detail', {
      title: `Review #${run.id} - Open Review`,
      csrfToken,
      run,
      findings,
    });
  });

  // -------------------------------------------------------------------------
  // POST /activity/:id/retrigger -- re-trigger a past review (DACT-04)
  // -------------------------------------------------------------------------
  fastify.post(
    '/activity/:id/retrigger',
    { preHandler: [requireLogin, fastify.csrfProtection] },
    async (req: Req, reply: Rep) => {
      const rawId = (req.params as Record<string, string>)['id'];
      const id = parseInt(rawId ?? '', 10);
      if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({ error: 'Invalid review run id.' });
      }

      const run = getReviewRunById(id);
      if (!run) {
        return reply.code(404).send({ error: 'Review run not found.' });
      }

      // Reconstruct the JobPayload from the stored row, omitting installationId when null.
      const jobPayload: Record<string, unknown> = {
        owner: run.owner,
        repo: run.repo,
        prNumber: run.pr_number,
        headSha: run.head_sha,
        baseSha: run.base_sha,
      };
      if (run.installation_id !== null && run.installation_id !== undefined) {
        jobPayload['installationId'] = run.installation_id;
      }

      _enqueue(run.pr_id, JSON.stringify(jobPayload));

      return reply.redirect('/activity');
    },
  );
}
