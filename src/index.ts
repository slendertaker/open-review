/**
 * Open Review -- boot entry point (D-01, D-08, D-12, D-18).
 *
 * Boot sequence:
 *   1. Load machine key + open DB (machine key needed for SqliteConfigStore).
 *   2. Construct SqliteConfigStore; seed from env on first run (D2-02).
 *   3. assertSqliteVersion: refuse to start if SQLite < 3.35 (Pitfall 8).
 *   4. assertClaudeVersion: refuse to start if Claude CLI < 2.1.163 (CVE-2026-55607).
 *   5. Boot setup-token gate (D2-09): log the setup URL when no password is set.
 *   6. Startup maintenance: prune old deliveries, orphaned worktrees.
 *   7. Crash recovery: reclaimRunning flips any 'running' rows back to 'pending'.
 *   8. Create queue, wire the review runner, start the drain loop.
 *   9. Build the Fastify server, start listening.
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

import { loadMachineKey } from './config/crypto.js';
import { SqliteConfigStore, seedFromEnvIfEmpty } from './config/sqlite-store.js';
import { openDb } from './state/db.js';
import { pruneOldDeliveries } from './state/deliveries.js';
import { pruneOldReviews } from './state/reviews.js';
import { createQueue } from './queue/queue.js';
import { buildServer } from './server.js';
import { runReview } from './worker/pipeline.js';
import { pruneOrphanedWorktrees } from './worker/repo.js';
import { assertSqliteVersion, assertClaudeVersion } from './startup.js';
import { bootSetupToken } from './dashboard/setup.js';
import { log } from './logger.js';
import type { JobPayload } from './queue/types.js';
import type { ClaimedJob } from './queue/queue.js';

async function main(): Promise<void> {
  // Step 1: Load machine key and open database.
  // Machine key is needed before SqliteConfigStore can decrypt secrets.
  const machineKey = loadMachineKey();

  // dbPath is a boot-only field -- read from env before the store exists.
  const dbPath = process.env['OPEN_REVIEW_DB_PATH'] ?? 'data/open-review.db';
  const db = openDb(dbPath);

  // Step 2: Construct the SQLite-backed config store.
  const store = new SqliteConfigStore(db, machineKey);

  // Seed settings + secrets from env on first run (D2-02, idempotent).
  seedFromEnvIfEmpty(db, machineKey);

  // Step 3: Safety gates -- refuse to start if versions are below the minimum.
  // Both checks run BEFORE listen() so no webhook is ever accepted on an unsafe env.
  assertSqliteVersion(db);
  await assertClaudeVersion();

  // Step 4: First-run setup token (D2-09).
  // Logs the setup URL at info level when no password is configured.
  // Operators who restart before setting a password can retrieve the URL here.
  bootSetupToken(store);

  // Step 5: Startup maintenance.
  pruneOldDeliveries();
  pruneOldReviews();
  await pruneOrphanedWorktrees();

  // Step 6: Create queue + crash recovery.
  const queue = createQueue(db);
  queue.reclaimRunning();

  // Step 7: Wire the review runner.
  // store reads live at job time -- no snapshot (DCFG-05).
  queue.setRunner(async (job: ClaimedJob) => {
    const payload = JSON.parse(job.payload) as JobPayload;
    await runReview(payload, store);
  });

  // Step 8: Build and start the server.
  // buildServer is now async (awaits plugin registrations).
  const server = await buildServer(
    store,
    db,
    (prId: string, payload: string) => queue.enqueue(prId, payload),
  );

  await server.listen({ port: store.port, host: store.host });
  log.info({ port: store.port, host: store.host }, 'open-review listening');

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
