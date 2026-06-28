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
 */

import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { verifySignature } from './webhook/verify.js';
import { shouldProcess } from './webhook/filter.js';
import { recordDelivery } from './state/deliveries.js';
import { log } from './logger.js';

export interface ServerOptions {
  webhookSecret: string;
  repos: string[];
  skipDrafts: boolean;
  skipForks: boolean;
  enqueue: (prId: string, payload: string) => void;
}

/**
 * Build and return the Fastify server instance.
 * The caller is responsible for calling server.listen().
 */
export function buildServer(opts: ServerOptions): FastifyInstance {
  const fastify = Fastify({ logger: false });

  // Raw-body parser: capture the exact bytes GitHub signed.
  // MUST be registered before any route that uses 'application/json'.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      // body is a Buffer; pass through as-is.
      done(null, body);
    },
  );

  // Health check.
  fastify.get('/healthz', async (_req, reply) => {
    return reply.code(200).send({ ok: true });
  });

  // GitHub webhook receiver.
  fastify.post('/webhook', async (req, reply) => {
    const rawBody = req.body as Buffer;
    const sigHeader = req.headers['x-hub-signature-256'] as string | undefined;
    const eventName = req.headers['x-github-event'] as string | undefined;
    const deliveryId = req.headers['x-github-delivery'] as string | undefined;

    // Step 1: HMAC verify BEFORE any JSON parse (T-01-S1).
    if (!verifySignature(rawBody, sigHeader, opts.webhookSecret)) {
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
    const filterResult = shouldProcess(eventName ?? '', payload, {
      repos: opts.repos,
      skipDrafts: opts.skipDrafts,
      skipForks: opts.skipForks,
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

    opts.enqueue(prId, jobPayload);
    log.info({ prId, headSha }, 'webhook: job enqueued');

    return reply.code(200).send({ ok: true });
  });

  return fastify;
}
