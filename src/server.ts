/**
 * Fastify server: raw-body HMAC verify, filter, dedup, persistent enqueue, reply 200.
 *
 * Security order (must not be changed):
 *   1. addContentTypeParser with parseAs:'buffer' captures the raw bytes.
 *   2. verifySignature runs over the raw Buffer BEFORE any JSON parse (T-01-S1).
 *   3. JSON.parse happens only after signature verification.
 *   4. shouldProcess, recordDelivery, enqueue, then reply 200.
 *
 * Concurrency: the queue's single-worker drain loop processes one job at a time
 * but the Fastify route always returns 200 immediately (INTK-05).
 *
 * Plugin registration order (mandatory per RESEARCH.md Pitfall 1):
 *   @fastify/cookie -> @fastify/session -> @fastify/csrf-protection ->
 *   @fastify/view -> @fastify/static -> dashboard routes
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
// Fastify uses CJS `export = fastify` style. With NodeNext module resolution
// and esModuleInterop, use `any` for the Fastify instance to avoid TypeScript
// errors from the CJS/ESM type boundary. Runtime behavior is correct.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import _Fastify from 'fastify';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyApp = any;
import fastifyCookie from '@fastify/cookie';
import fastifySession from '@fastify/session';
import fastifyCsrf from '@fastify/csrf-protection';
import fastifyView from '@fastify/view';
import { Eta } from 'eta';
import fastifyStatic from '@fastify/static';
import { verifySignature } from './webhook/verify.js';
import { shouldProcess } from './webhook/filter.js';
import { recordDelivery } from './state/deliveries.js';
import { SqliteSessionStore } from './state/sessions.js';
import { setSetting } from './state/config-state.js';
import { registerSetupRoutes } from './dashboard/setup.js';
import { registerDashboardRoutes } from './dashboard/routes.js';
import { log } from './logger.js';
import type { ConfigStore } from './config/store.js';
import type Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/**
 * Build and return the Fastify server instance.
 *
 * Phase 2 refactor: buildServer(store, db, enqueue) replaces buildServer(opts).
 * All config reads happen live from the store per-request (DCFG-05, D2-03).
 * The caller is responsible for calling server.listen().
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function buildServer(
  store: ConfigStore,
  db: Database.Database,
  enqueue: (prId: string, payload: string) => void,
): Promise<FastifyApp> {
  // trustProxy: true -- required for secure:'auto' cookie behavior behind Caddy (D2-11, Pitfall 2).
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment
  const fastify: FastifyApp = (_Fastify as unknown as (opts: Record<string, unknown>) => FastifyApp)(
    { logger: false, trustProxy: true },
  );

  // Raw-body parser: capture the exact bytes GitHub signed.
  // MUST be registered before any route that uses 'application/json'.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req: any, body: any, done: any) => {
      // body is a Buffer; pass through as-is.
      done(null, body);
    },
  );

  // -------------------------------------------------------------------------
  // Plugin registration order: cookie -> session -> csrf -> view -> static
  // (RESEARCH.md Pitfall 1 -- each plugin depends on the previous)
  // -------------------------------------------------------------------------

  // 1. Cookie plugin (required before session)
  await fastify.register(fastifyCookie);

  // 2. Session plugin
  // Resolve the session secret: persist at first run; reuse thereafter (D2-07).
  let sessionSecret = store.sessionSecret;
  if (!sessionSecret || sessionSecret.trim() === '') {
    sessionSecret = randomBytes(32).toString('hex');
    setSetting('session_secret', sessionSecret);
  }

  await fastify.register(fastifySession, {
    secret: sessionSecret,
    store: new SqliteSessionStore(db),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // secure:'auto' reads req.secure which is correct when trustProxy:true.
      // Secure flag is present behind Caddy (X-Forwarded-Proto=https) and absent
      // over plain HTTP. Full Caddy/HTTPS behavior validated in Phase 4 (D2-11).
      secure: 'auto' as const,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
    saveUninitialized: false,
  });

  // 3. CSRF protection (must be after session -- reads session store for secret)
  await fastify.register(fastifyCsrf, {
    sessionPlugin: '@fastify/session',
  });

  // 4. View engine -- Eta templates with project-root-relative templates dir
  await fastify.register(fastifyView, {
    engine: { eta: new Eta() },
    templates: path.join(PROJECT_ROOT, 'views'),
    layout: 'layout.eta',
    includeViewExtension: true,
    production: process.env['NODE_ENV'] === 'production',
  });

  // 5. Static file server -- serves public/ under /
  await fastify.register(fastifyStatic, {
    root: path.join(PROJECT_ROOT, 'public'),
    prefix: '/',
  });

  // -------------------------------------------------------------------------
  // Unauthenticated routes (exempt from session gate)
  // -------------------------------------------------------------------------

  // Health check.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fastify.get('/healthz', async (_req: any, reply: any) => {
    return reply.code(200).send({ ok: true });
  });

  // First-run setup routes (exempt from session gate; own token gate inside)
  await registerSetupRoutes(fastify, store);

  // -------------------------------------------------------------------------
  // GitHub webhook receiver.
  // Config is read live from the store per request (DCFG-05, D2-03).
  // -------------------------------------------------------------------------
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fastify.post('/webhook', async (req: any, reply: any) => {
    const rawBody = req.body as Buffer;
    const sigHeader = req.headers['x-hub-signature-256'] as string | undefined;
    const eventName = req.headers['x-github-event'] as string | undefined;
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;

    // Step 1: HMAC verify BEFORE any JSON parse (T-01-S1).
    // webhookSecret is a live getter -- reads SQLite per request (DCFG-05).
    if (!verifySignature(rawBody, sigHeader, store.webhookSecret)) {
      log.warn({ deliveryId }, 'webhook: invalid signature -- rejected');
      return reply.code(401).send({ error: 'Invalid signature' });
    }

    // Step 2: Parse JSON now that the signature is verified.
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return reply.code(400).send({ error: 'Invalid JSON body' });
    }

    // Step 3: Filter -- check event type, action, allowlist, draft, fork.
    // All filter fields are live getters (DCFG-05).
    const filterResult = shouldProcess(eventName ?? '', payload, {
      repos: store.repos,
      skipDrafts: store.skipDrafts,
      skipForks: store.skipForks,
    });

    if (!filterResult.process) {
      log.debug({ eventName, reason: filterResult.reason }, 'webhook: skipped');
      return reply.code(200).send({ ok: true, skipped: true, reason: filterResult.reason });
    }

    // Step 4: Delivery dedup (INSERT OR IGNORE).
    if (deliveryId) {
      const { isNew } = recordDelivery(deliveryId);
      if (!isNew) {
        log.debug({ deliveryId }, 'webhook: duplicate delivery -- skipped');
        return reply.code(200).send({ ok: true, skipped: true, reason: 'duplicate delivery' });
      }
    }

    // Step 5: Extract job coordinates and enqueue BEFORE replying (Pitfall 4).
    const p = payload as {
      repository: { full_name: string };
      pull_request: {
        number: number;
        head: { sha: string; repo?: { full_name?: string } | null };
        base: { sha: string };
      };
      installation?: { id: number };
    };

    const [owner, repo] = (p.repository?.full_name ?? '/').split('/');
    const prNumber = p.pull_request?.number;
    const headSha = p.pull_request?.head?.sha;
    const baseSha = p.pull_request?.base?.sha;
    const installationId = p.installation?.id;

    if (!owner || !repo || !prNumber || !headSha || !baseSha) {
      log.warn({ payload: 'redacted' }, 'webhook: missing required PR fields');
      return reply.code(400).send({ error: 'Missing required PR fields' });
    }

    const prId = `${owner}/${repo}#${prNumber}`;
    const jobPayload = JSON.stringify({
      owner,
      repo,
      prNumber,
      headSha,
      baseSha,
      ...(installationId !== undefined ? { installationId } : {}),
    });

    enqueue(prId, jobPayload);
    log.info({ prId, headSha }, 'webhook: job enqueued');

    return reply.code(200).send({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Authenticated dashboard routes (all gated by requireLogin in routes.ts)
  // -------------------------------------------------------------------------
  await registerDashboardRoutes(fastify, store, db);

  return fastify;
}
