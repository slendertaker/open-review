/**
 * Open Review -- boot entry point (D-01, D-12, D-18).
 *
 * Boot sequence:
 *   1. Load EnvConfigStore (fails fast if WEBHOOK_SECRET missing).
 *   2. openDb: WAL, schema, prepared statements.
 *   3. Startup prune of old deliveries and orphaned worktrees.
 *   4. Crash recovery: reclaimRunning flips any 'running' rows back to 'pending'.
 *   5. Create queue, wire the review runner, start the drain loop.
 *   6. Build the Fastify server, start listening.
 *
 * Local full-stack run (manual end-to-end smoke):
 *
 *   OPEN_REVIEW_WEBHOOK_SECRET=<your-secret> \
 *   GITHUB_TOKEN=<your-pat> \
 *   CLAUDE_CODE_OAUTH_TOKEN=<from-claude-setup-token> \
 *   npm run start:dev
 *
 *   Then forward a real GitHub pull_request webhook to http://localhost:3000/webhook
 *   (e.g. via a smee.io channel or ngrok) to trigger a full review cycle.
 */

import { EnvConfigStore } from './config/store.js';
import { openDb } from './state/db.js';
import { pruneOldDeliveries } from './state/deliveries.js';
import { createQueue } from './queue/queue.js';
import { buildServer } from './server.js';
import { runReview } from './worker/pipeline.js';
import { pruneOrphanedWorktrees } from './worker/repo.js';
import { log } from './logger.js';
import type { JobPayload } from './queue/types.js';
import type { ClaimedJob } from './queue/queue.js';

async function main(): Promise<void> {
  // Step 1: Load config.
  const config = new EnvConfigStore();

  // Step 2: Open database.
  const db = openDb(config.dbPath);

  // Step 3: Startup maintenance.
  pruneOldDeliveries();
  await pruneOrphanedWorktrees();

  // Step 4: Create queue + crash recovery.
  const queue = createQueue(db);
  queue.reclaimRunning();

  // Step 5: Wire the review runner.
  queue.setRunner(async (job: ClaimedJob) => {
    const payload = JSON.parse(job.payload) as JobPayload;
    await runReview(payload, config);
  });

  // Step 6: Build and start the server.
  const server = buildServer({
    webhookSecret: config.webhookSecret,
    repos: config.repos,
    skipDrafts: config.skipDrafts,
    skipForks: config.skipForks,
    enqueue: (prId: string, payload: string) => queue.enqueue(prId, payload),
  });

  await server.listen({ port: config.port, host: config.host });
  log.info({ port: config.port, host: config.host }, 'open-review listening');

  // Start worker drain loop after server is up.
  queue.startDrainLoop();

  // Graceful shutdown.
  const shutdown = async (): Promise<void> => {
    log.info('shutting down...');
    queue.stop();
    await server.close();
    db.close();
    process.exit(0);
  };

  process.once('SIGTERM', () => { void shutdown(); });
  process.once('SIGINT', () => { void shutdown(); });
}

main().catch((err: unknown) => {
  log.error({ err: String(err) }, 'fatal boot error');
  process.exit(1);
});
