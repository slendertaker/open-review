/**
 * Dashboard authentication: login/logout handlers, requireLogin preHandler,
 * and in-memory per-IP lockout counter (DSEC-01, D2-10).
 *
 * Session fixation mitigation: req.session.regenerate() is called BEFORE
 * setting the authenticated flag on the new session (T-02-07).
 *
 * Lockout: after MAX_ATTEMPTS failed logins from an IP, further attempts are
 * rejected for LOCKOUT_WINDOW_MS. Resets to zero on successful login.
 * The counter is in-memory (resets on restart) -- acceptable for single-operator (D2-10).
 */

import argon2 from 'argon2';
import { getSetting } from '../state/config-state.js';
import { log } from '../logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyRequest = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyReply = any;

// ---------------------------------------------------------------------------
// Lockout counter
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

// Defense-in-depth global ceiling (CR-01, IN-04). The per-IP lockout above can be
// evaded when the node is reachable directly (no trusted proxy overwriting
// X-Forwarded-For), because an attacker rotates the client IP on every request and
// no single key accumulates MAX_ATTEMPTS. This global counter is NOT keyed on any
// client-derived value: once total failed attempts within the window cross the
// ceiling, ALL further attempts are locked regardless of source IP. The ceiling is
// set well above MAX_ATTEMPTS so a single legitimate operator's lockout-and-retry
// cycle never trips it, while a header-rotating brute-forcer is still bounded.
const GLOBAL_MAX_ATTEMPTS = 100;
// Reserved key in lockoutMap so the global counter shares the map's lifecycle
// (tests reset state via lockoutMap.clear(), which must also reset the global counter).
const GLOBAL_KEY = '__global__';

interface LockoutEntry {
  attempts: number;
  lockedUntil: number; // epoch ms; 0 = not locked
}

const lockoutMap = new Map<string, LockoutEntry>();

function getClientIp(req: FastifyRequest): string {
  // With trustProxy:'loopback', Fastify sets req.ip from X-Forwarded-For only when
  // the immediate peer is the local reverse proxy (127.0.0.1/::1); otherwise req.ip
  // is the real socket address, which a remote client cannot forge.
  return req.ip ?? 'unknown';
}

/** Returns true when the global (not IP-keyed) attempt ceiling is currently tripped. */
function isGloballyLocked(): boolean {
  const entry = lockoutMap.get(GLOBAL_KEY);
  if (!entry || entry.lockedUntil === 0) return false;
  if (Date.now() >= entry.lockedUntil) {
    lockoutMap.delete(GLOBAL_KEY);
    return false;
  }
  return true;
}

/** Record a failure against the global ceiling (independent of client IP). */
function recordGlobalFailure(): void {
  const entry = lockoutMap.get(GLOBAL_KEY) ?? { attempts: 0, lockedUntil: 0 };
  entry.attempts += 1;
  if (entry.attempts >= GLOBAL_MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_WINDOW_MS;
  }
  lockoutMap.set(GLOBAL_KEY, entry);
}

function isLocked(ip: string): { locked: boolean; minutesLeft: number } {
  const entry = lockoutMap.get(ip);
  if (!entry || entry.lockedUntil === 0) return { locked: false, minutesLeft: 0 };
  if (Date.now() >= entry.lockedUntil) {
    lockoutMap.delete(ip);
    return { locked: false, minutesLeft: 0 };
  }
  const minutesLeft = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
  return { locked: true, minutesLeft };
}

function recordFailure(ip: string): void {
  const entry = lockoutMap.get(ip) ?? { attempts: 0, lockedUntil: 0 };
  entry.attempts += 1;
  if (entry.attempts >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCKOUT_WINDOW_MS;
  }
  lockoutMap.set(ip, entry);
}

function clearFailures(ip: string): void {
  lockoutMap.delete(ip);
}

// Exported for testing
export { lockoutMap };

// ---------------------------------------------------------------------------
// requireLogin preHandler
// ---------------------------------------------------------------------------

/**
 * Fastify preHandler that redirects to /login when the session is not
 * authenticated. Add to any route that requires auth.
 */
export async function requireLogin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.session.get('authenticated')) {
    return reply.redirect('/login');
  }
}

// ---------------------------------------------------------------------------
// loginHandler
// ---------------------------------------------------------------------------

/**
 * POST /login handler.
 * Verifies password with argon2, regenerates session on success, tracks failures.
 */
export async function loginHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const ip = getClientIp(req);

  // Check the global ceiling first (CR-01): backstops IP-rotation brute force when
  // no trusted proxy is present. Not keyed on any client-derived value.
  if (isGloballyLocked()) {
    req.session.set(
      'flashError',
      'Too many failed attempts. Try again later.',
    );
    return reply.redirect('/login');
  }

  // Then the per-IP lockout.
  const lockoutStatus = isLocked(ip);
  if (lockoutStatus.locked) {
    req.session.set('flashError', `Too many failed attempts. Try again in ${lockoutStatus.minutesLeft} minutes.`);
    return reply.redirect('/login');
  }

  const body = req.body as Record<string, string>;
  const candidatePassword = body['password'] ?? '';

  const storedHash = getSetting('password_hash');
  if (!storedHash) {
    // No password set -- should not reach here (setup gate handles this).
    return reply.redirect('/setup');
  }

  let valid = false;
  try {
    valid = await argon2.verify(storedHash, candidatePassword);
  } catch {
    // Unexpected error during verify -- treat as failure.
    log.warn({ ip }, 'login: argon2.verify threw unexpectedly');
  }

  if (!valid) {
    recordFailure(ip);
    recordGlobalFailure();
    req.session.set('flashError', 'Incorrect password. Try again.');
    return reply.redirect('/login');
  }

  // Success: regenerate session to prevent session fixation (T-02-07).
  await req.session.regenerate();

  req.session.set('authenticated', true);
  clearFailures(ip);

  return reply.redirect('/dashboard');
}

// ---------------------------------------------------------------------------
// logoutHandler
// ---------------------------------------------------------------------------

/**
 * GET /logout handler.
 * Destroys the session server-side and redirects to /login.
 * GET is correct here: the session is destroyed server-side and the link
 * needs no CSRF token (UI-SPEC mandates GET /logout).
 */
export async function logoutHandler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await req.session.destroy();
  return reply.redirect('/login');
}
