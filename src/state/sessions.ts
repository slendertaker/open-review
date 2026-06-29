/**
 * SqliteSessionStore: @fastify/session-compatible session store (DSEC-03, D2-07).
 *
 * Implements the express-session custom store interface (get/set/destroy)
 * using better-sqlite3 prepared statements against the sessions table.
 * The sessions table is created in the constructor so the store is self-sufficient
 * even with a DB opened outside openDb (RESEARCH.md Pattern 3).
 *
 * prune() deletes expired rows (called periodically or at startup).
 * initSessions(db) is exported for symmetry with other state modules; it is
 * a thin wrapper that simply constructs the store (the constructor prepares
 * all statements). Pass the returned store to buildServer.
 */

import type Database from 'better-sqlite3';
import type { Session } from 'fastify';

type Statement = Database.Statement<unknown[]>;
// @fastify/session store callback types
type SessionCallback = (err: Error | null, session?: unknown) => void;
type FastifyCallback = (err?: Error | null | undefined) => void;

export class SqliteSessionStore {
  private readonly stmtGet: Statement;
  private readonly stmtSet: Statement;
  private readonly stmtDestroy: Statement;
  private readonly stmtPrune: Statement;
  private readonly stmtDeleteAllExcept: Statement;

  constructor(db: Database.Database) {
    // Create table inline so the store works without schema.sql (Pattern 3).
    // schema.sql also declares this table with IF NOT EXISTS for visibility.
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        data       TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
    `);

    this.stmtGet = db.prepare(
      "SELECT data FROM sessions WHERE id = ? AND expires_at > datetime('now')",
    );
    // TTL: compute expires_at from cookie.maxAge (milliseconds -> seconds).
    this.stmtSet = db.prepare(
      "INSERT OR REPLACE INTO sessions(id, data, expires_at) VALUES(?, ?, datetime('now', ? || ' seconds'))",
    );
    this.stmtDestroy = db.prepare('DELETE FROM sessions WHERE id = ?');
    this.stmtPrune = db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')");
    this.stmtDeleteAllExcept = db.prepare('DELETE FROM sessions WHERE id != ?');
  }

  /**
   * Delete every session row except the one with the given id (WR-01).
   * Used after a password change to revoke all other active sessions while
   * keeping the operator's current session signed in (DSEC-01).
   */
  deleteAllExcept(currentId: string): void {
    this.stmtDeleteAllExcept.run(currentId);
  }

  /**
   * Retrieve a session by ID. Passes undefined to the callback if not found or expired.
   */
  get(id: string, callback: (err: Error | null, session?: Session | null) => void): void {
    try {
      const row = this.stmtGet.get(id) as { data: string } | undefined;
      callback(null, row ? (JSON.parse(row.data) as Session) : undefined);
    } catch (err) {
      callback(err as Error);
    }
  }

  /**
   * Save (upsert) a session. TTL is derived from session.cookie.maxAge (ms),
   * defaulting to 24 hours when not present.
   */
  set(id: string, session: Session, callback: FastifyCallback): void {
    try {
      const cookieInfo = (session as unknown as Record<string, unknown>)['cookie'] as { maxAge?: number } | undefined;
      const ttlSeconds = cookieInfo?.maxAge != null
        ? Math.floor(cookieInfo.maxAge / 1000)
        : 86400; // 24 h default
      this.stmtSet.run(id, JSON.stringify(session), String(ttlSeconds));
      callback(null);
    } catch (err) {
      callback(err as Error);
    }
  }

  /**
   * Destroy a session by ID. No-op if not present.
   */
  destroy(id: string, callback: FastifyCallback): void {
    try {
      this.stmtDestroy.run(id);
      callback(null);
    } catch (err) {
      callback(err as Error);
    }
  }

  /**
   * Delete all expired sessions. Safe to call at startup or on a periodic timer.
   */
  prune(): void {
    this.stmtPrune.run();
  }
}

/**
 * Factory helper for symmetry with other state init functions.
 * openDb does NOT need to call this directly -- SqliteSessionStore is
 * constructed by buildServer with the shared db handle.
 */
export function initSessions(db: Database.Database): SqliteSessionStore {
  return new SqliteSessionStore(db);
}

/**
 * Revoke all sessions except the current one, operating directly on a db handle
 * (WR-01). Used by the change-password route, which holds the shared db handle but
 * not the SqliteSessionStore instance. Safe to call even if the sessions table is
 * empty. The statement is prepared per call (this runs at most once per password
 * change, not on a hot path).
 */
export function deleteAllSessionsExcept(db: Database.Database, currentId: string): void {
  db.prepare('DELETE FROM sessions WHERE id != ?').run(currentId);
}
