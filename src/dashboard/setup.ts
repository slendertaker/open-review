/**
 * First-run setup-token flow (DSEC-01, D2-09).
 *
 * bootSetupToken: generates and stores a setup token when no password is set;
 * logs the first-run setup URL so the operator can access it; returns null if
 * a password is already configured.
 *
 * registerSetupRoutes: registers GET /setup and POST /setup. These routes are
 * exempt from the session gate and operate only via the setup token.
 */

import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type FastifyApp = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rep = any;
import { getSetting, setSetting } from '../state/config-state.js';
import { log } from '../logger.js';
import type { ConfigStore } from '../config/store.js';

// ---------------------------------------------------------------------------
// In-memory lockout counter (shared with auth.ts would cause circular dep,
// so setup uses a local gate: just redirect to /login if password already set)
// ---------------------------------------------------------------------------

/**
 * Generate and store a setup token if no password is configured.
 * Emits the first-run setup URL at info level (required -- Pattern 7).
 * Returns null when a password is already set.
 */
export function bootSetupToken(store: ConfigStore): string | null {
  if (getSetting('password_hash')) return null; // password already set

  const token = randomBytes(24).toString('hex'); // 48-char hex token
  setSetting('setup_token', token);

  // MANDATORILY log the setup URL (Pattern 7). Without this an operator who
  // restarts before setting a password has no way to recover the token.
  const port = store.port;
  const setupUrl = `http://localhost:${port}/setup?token=${token}`;
  log.info(
    { setupUrl },
    'FIRST RUN: no password set -- open the setup URL to configure dashboard access',
  );

  return token;
}

/**
 * Register the setup gate hook plus GET /setup and POST /setup.
 *
 * The gate redirects every gated route to /setup when no password is set.
 * Routes exempt from the gate: /setup, /login, /healthz, /webhook, /vendor/*.
 */
export async function registerSetupRoutes(
  fastify: FastifyApp,
  store: ConfigStore,
): Promise<void> {
  // -------------------------------------------------------------------------
  // Setup gate: runs on every request; redirects to /setup when no password set
  // -------------------------------------------------------------------------
  fastify.addHook('onRequest', async (req: Req, reply: Rep) => {
    // Exempt routes that are always accessible regardless of auth state.
    const url = req.url.split('?')[0] ?? '';

    const passwordSet = !!getSetting('password_hash');

    // When a password is already set, /setup is closed: redirect to /login.
    // This runs in onRequest, BEFORE the route's CSRF protection, so a stale
    // POST /setup after password set cleanly redirects rather than 403ing.
    if (passwordSet && url === '/setup') {
      return reply.redirect('/login');
    }

    const isExempt =
      url === '/setup' ||
      url === '/login' ||
      url === '/healthz' ||
      url.startsWith('/webhook') ||
      url.startsWith('/vendor') ||
      url.startsWith('/favicon');

    if (isExempt) return;

    // If no password is set, redirect all gated routes to /setup.
    if (!passwordSet) {
      return reply.redirect('/setup');
    }
  });

  // -------------------------------------------------------------------------
  // GET /setup -- render setup form or invalid-token error state
  // -------------------------------------------------------------------------
  fastify.get('/setup', async (req: Req, reply: Rep) => {
    // If a password is already set, redirect to /login.
    if (getSetting('password_hash')) {
      return reply.redirect('/login');
    }

    const query = req.query as { token?: string };
    const token = query.token ?? '';
    const storedToken = getSetting('setup_token');

    const tokenValid = token && storedToken && token === storedToken;

    if (!tokenValid) {
      return reply.viewAsync('setup', {
        title: 'Set up Open Review',
        tokenValid: false,
        token: '',
        error: null,
        csrfToken: '',
      });
    }

    const csrfToken = await reply.generateCsrf();
    return reply.viewAsync('setup', {
      title: 'Set up Open Review',
      tokenValid: true,
      token,
      error: null,
      csrfToken,
    });
  });

  // -------------------------------------------------------------------------
  // POST /setup -- validate token, set password, create session
  // -------------------------------------------------------------------------
  // CSRF protection runs as preHandler (NOT onRequest): the _csrf token lives in
  // the form body, and req.body is only parsed at the preValidation/preHandler
  // phase. At onRequest the body is undefined, so token verification would always
  // fail (Rule 1 fix vs RESEARCH.md's header-token onRequest example).
  fastify.post(
    '/setup',
    { preHandler: fastify.csrfProtection },
    async (req: Req, reply: Rep) => {
      // If password already set, redirect to /login.
      if (getSetting('password_hash')) {
        return reply.redirect('/login');
      }

      const body = req.body as Record<string, string>;
      const token = body['token'] ?? '';
      const password = body['password'] ?? '';
      const confirm = body['confirm'] ?? '';

      const storedToken = getSetting('setup_token');
      const tokenValid = token && storedToken && token === storedToken;

      if (!tokenValid) {
        const csrfToken = await reply.generateCsrf();
        return reply.viewAsync('setup', {
          title: 'Set up Open Review',
          tokenValid: false,
          token,
          error: 'This setup link is invalid or has already been used. Restart the service to generate a new one.',
          csrfToken,
        });
      }

      // Validate password length.
      if (password.length < 12) {
        const csrfToken = await reply.generateCsrf();
        return reply.viewAsync('setup', {
          title: 'Set up Open Review',
          tokenValid: true,
          token,
          error: 'Password must be at least 12 characters.',
          csrfToken,
        });
      }

      // Validate password confirmation.
      if (password !== confirm) {
        const csrfToken = await reply.generateCsrf();
        return reply.viewAsync('setup', {
          title: 'Set up Open Review',
          tokenValid: true,
          token,
          error: 'Passwords do not match.',
          csrfToken,
        });
      }

      // Hash the password with argon2id and store it.
      const hash = await argon2.hash(password, { type: argon2.argon2id });
      setSetting('password_hash', hash);

      // Invalidate the setup token.
      setSetting('setup_token', '');

      // Create an authenticated session.
      // Regenerate session ID to prevent session fixation (T-02-07).
      await req.session.regenerate();
      req.session.set('authenticated', true);

      return reply.redirect('/dashboard');
    },
  );
}
