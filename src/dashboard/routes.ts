/**
 * Dashboard route registrar (DSEC-01, DCFG-01, BRND-01).
 *
 * Mounts all authenticated dashboard routes:
 *   GET /login, POST /login, GET /logout -- auth lifecycle
 *   GET /dashboard -- main settings page (requires auth)
 *   Delegates to five per-section registrars (Plans 03/04/05 fill bodies).
 *
 * The per-section stubs are imported unconditionally so this file is the
 * single mount point -- Wave 3 plans never edit routes.ts or index.eta.
 */

import { getSetting, getSecretRecord } from '../state/config-state.js';
import { requireLogin, loginHandler, logoutHandler } from './auth.js';
import { registerGeneralRoutes } from './routes-general.js';
import { registerReposRoutes } from './routes-repos.js';
import { registerProviderRoutes } from './routes-provider.js';
import { registerSecretsRoutes } from './routes-secrets.js';
import { registerAccessRoutes } from './routes-access.js';
import { registerActivityRoutes } from './routes-activity.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFastify = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rep = any;
import type Database from 'better-sqlite3';
import type { ConfigStore } from '../config/store.js';

export async function registerDashboardRoutes(
  fastify: AnyFastify,
  store: ConfigStore,
  db: Database.Database,
  enqueue: (prId: string, payload: string) => void = () => {},
): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /login -- render login page
  // -------------------------------------------------------------------------
  fastify.get('/login', async (req: Req, reply: Rep) => {
    // If already authenticated, redirect to dashboard.
    if (req.session.get('authenticated')) {
      return reply.redirect('/dashboard');
    }

    const flashError = req.session.get('flashError');
    if (flashError) {
      req.session.set('flashError', undefined as unknown as string);
      await req.session.save();
    }

    const csrfToken = await reply.generateCsrf();

    // No-domain HTTP-only warning banner (Surface 3, DSEC-02, D2-11).
    const showNoDomainBanner = !store.domain && req.protocol === 'http';

    return reply.viewAsync('login', {
      title: 'Sign in - Open Review',
      csrfToken,
      flashError: flashError ?? null,
      showNoDomainBanner,
    }, { layout: 'layout.eta' });
  });

  // -------------------------------------------------------------------------
  // POST /login -- authenticate
  // CSRF protection runs as preHandler (not onRequest): the _csrf token is in
  // the form body, which is only parsed at preHandler time (see setup.ts note).
  // -------------------------------------------------------------------------
  fastify.post(
    '/login',
    { preHandler: fastify.csrfProtection },
    loginHandler,
  );

  // -------------------------------------------------------------------------
  // GET /logout -- destroy session (GET per UI-SPEC mandate; no CSRF needed)
  // -------------------------------------------------------------------------
  fastify.get('/logout', logoutHandler);

  // -------------------------------------------------------------------------
  // GET /dashboard -- main settings page (requires authentication)
  // -------------------------------------------------------------------------
  fastify.get('/dashboard', { preHandler: requireLogin }, async (req: Req, reply: Rep) => {
    const csrfToken = await reply.generateCsrf();

    return reply.viewAsync('dashboard/index', {
      title: 'Settings - Open Review',
      csrfToken,
      // Pass current config values for the section partials.
      minSeverity: store.minSeverity,
      skipDrafts: store.skipDrafts,
      skipForks: store.skipForks,
      ignoreGlobs: store.ignoreGlobs.join('\n'),
      repos: store.repos,
      provider: store.provider,
      domain: store.domain ?? '',
      // Secret presence flags (write-only -- never send plaintext).
      // webhook_secret lives in the settings table; the five encrypted credentials
      // are stored in the secrets table via setSecretRecord, so their presence must
      // be read with getSecretRecord (getSetting would always miss and render "(not set)").
      hasWebhookSecret: !!getSetting('webhook_secret'),
      hasClaudeOauthToken: !!getSecretRecord('claude_oauth_token'),
      hasAnthropicApiKey: !!getSecretRecord('anthropic_api_key'),
      hasGithubToken: !!getSecretRecord('github_token'),
      hasGithubAppId: !!getSecretRecord('github_app_id'),
      hasGithubAppPrivateKey: !!getSecretRecord('github_app_private_key'),
    }, { layout: 'layout.eta' });
  });

  // -------------------------------------------------------------------------
  // Per-section route registrars (Wave 3 plans fill in the bodies)
  // -------------------------------------------------------------------------
  await registerGeneralRoutes(fastify, store, db);
  await registerReposRoutes(fastify, store, db);
  await registerProviderRoutes(fastify, store, db);
  await registerSecretsRoutes(fastify, store, db);
  await registerAccessRoutes(fastify, store, db);
  await registerActivityRoutes(fastify, store, db, enqueue);
}
