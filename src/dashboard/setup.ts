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

import { randomBytes, timingSafeEqual } from 'node:crypto';
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
 * Constant-time comparison of the supplied setup token against the stored token
 * (CR-02). The setup token is a pre-auth account-takeover credential, so it must
 * be compared like any other secret to avoid leaking length/content via timing.
 * Length-safe: returns false for mismatched lengths without calling timingSafeEqual
 * on unequal-length buffers (which would throw).
 */
function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Generate and store a setup token if no password is configured.
 * Emits the first-run setup URL at info level (required -- Pattern 7).
 * Returns null when a password is already set.
 */
export function bootSetupToken(store: ConfigStore): string | null {
  if (getSetting('password_hash')) return null; // password already set

  const token = randomBytes(24).toString('hex'); // 48-char hex token
  setSetting('setup_token', token);

  // MANDATORILY surface the setup URL (Pattern 7). Without this an operator who
  // restarts before setting a password has no way to recover the token.
  //
  // CR-02: the token is a pre-auth account-takeover credential and must NOT enter
  // the structured log sink (journald -> aggregation/backups). The info log carries
  // only the token-free path; the full token URL is written once to stdout via
  // console.log, which the pino sink does not capture.
  const port = store.port;
  // IN-06: prefer the configured public domain (the operator reaches the box by domain,
  // not localhost). Fall back to localhost:port and tell the operator to substitute their
  // own host/IP when connecting remotely.
  const setupPath = store.domain
    ? `https://${store.domain}/setup`
    : `http://localhost:${port}/setup`;
  const setupUrl = `${setupPath}?token=${token}`;
  log.info(
    { setupUrl: setupPath },
    'FIRST RUN: no password set -- open the setup URL (printed below) to configure dashboard access',
  );
  const hostHint = store.domain ? '' : ' (replace localhost with your host/IP if connecting remotely)';
  // eslint-disable-next-line no-console
  console.log(`\nFIRST RUN setup URL${hostHint} (one time, not logged): ${setupUrl}\n`);

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
      // Static-asset surface (public/ = fonts, styles, vendor) served by @fastify/static.
      // These MUST bypass the first-run redirect -- layout.eta loads dashboard.css and
      // the Geist font files on every page, including /setup and /login themselves, so
      // gating them behind /setup renders both pages with zero styling on first run.
      url.startsWith('/vendor') ||
      url.startsWith('/styles') ||
      url.startsWith('/fonts') ||
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

    const tokenValid = !!token && !!storedToken && tokensMatch(token, storedToken);

    if (!tokenValid) {
      return reply.viewAsync('setup', {
        title: 'Set up Open Review',
        tokenValid: false,
        token: '',
        error: null,
        csrfToken: '',
      }, { layout: 'layout.eta' });
    }

    const csrfToken = await reply.generateCsrf();
    return reply.viewAsync('setup', {
      title: 'Set up Open Review',
      tokenValid: true,
      token,
      error: null,
      csrfToken,
    }, { layout: 'layout.eta' });
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
      const tokenValid = !!token && !!storedToken && tokensMatch(token, storedToken);

      if (!tokenValid) {
        const csrfToken = await reply.generateCsrf();
        return reply.viewAsync('setup', {
          title: 'Set up Open Review',
          tokenValid: false,
          token,
          error: 'This setup link is invalid or has already been used. Restart the service to generate a new one.',
          csrfToken,
        }, { layout: 'layout.eta' });
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
        }, { layout: 'layout.eta' });
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
        }, { layout: 'layout.eta' });
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
