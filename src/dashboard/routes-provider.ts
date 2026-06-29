/**
 * Provider section route stub (DCFG-04).
 * Plan 04 fills in the route body. This stub exists so routes.ts can import
 * it unconditionally and the full suite compiles with zero Plan 02 changes.
 */

import type Database from 'better-sqlite3';
import type { ConfigStore } from '../config/store.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFastify = any;

export async function registerProviderRoutes(
  _fastify: AnyFastify,
  _store: ConfigStore,
  _db: Database.Database,
): Promise<void> {
  // Plan 04 populates this function body.
}
