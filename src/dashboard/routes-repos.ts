/**
 * Repositories section route stub (DCFG-03).
 * Plan 03 fills in the route body. This stub exists so routes.ts can import
 * it unconditionally and the full suite compiles with zero Plan 02 changes.
 */

import type Database from 'better-sqlite3';
import type { ConfigStore } from '../config/store.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFastify = any;

export async function registerReposRoutes(
  _fastify: AnyFastify,
  _store: ConfigStore,
  _db: Database.Database,
): Promise<void> {
  // Plan 03 populates this function body.
}
