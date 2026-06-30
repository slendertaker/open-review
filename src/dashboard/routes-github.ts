/**
 * GitHub App Manifest connect flow routes (GHUB-01, GHUB-04, GHUB-05).
 *
 * Exports registerGithubRoutes(fastify, store, db) which mounts:
 *
 *   GET /dashboard/github
 *     - requireLogin
 *     - Not-connected: renders github partial with Connect button.
 *     - Connected (github_app_slug set): renders connected-identity scaffold.
 *       Plan 04 extends this route with live installation/repo listing.
 *
 *   GET /dashboard/github/connect
 *     - requireLogin
 *     - Generates a per-session state token (session-bound CSRF, D5-06).
 *     - Builds the manifest JSON server-side with the corrected permission set
 *       (pull_requests:write, issues:write, contents:read, metadata:read).
 *     - Derives base URL from the persisted domain or the request host.
 *     - Builds the GitHub create-App URL with the state token in the query string.
 *     - Renders the partial in connect mode (auto-submitting manifest form).
 *
 *   GET /dashboard/github/callback
 *     - requireLogin (NO csrfProtection -- the state token is the CSRF control, D5-06)
 *     - Verifies the query state against the session-stored state with timingSafeEqual.
 *     - Clears the session state IMMEDIATELY on match (replay defense, Pitfall 3).
 *     - Exchanges the one-time code via unauthenticated Octokit.rest.apps.createFromManifest.
 *     - Persists all credentials:
 *         identity settings: github_app_id, github_app_slug, github_app_name,
 *                            github_app_html_url, github_client_id
 *         encrypted secrets: github_app_private_key (pem), github_client_secret
 *         plain setting:     webhook_secret (guarded for null -- Pitfall 1)
 *     - Redirects to /dashboard/github/install on success.
 *     - On state mismatch: 400 without calling createFromManifest (T-05-05).
 *     - On conversion error: 200 with error flash (never 500).
 *
 * Security notes:
 *   - pem and client_secret are NEVER passed to a template or logged in plaintext.
 *   - All catch blocks log scrub(String(err)) only.
 *   - Org login in the connect URL is validated against [A-Za-z0-9-] (T-05-07).
 *   - No em-dashes in any operator-facing copy (BRND-02).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Octokit } from '@octokit/rest';
import type { ConfigStore } from '../config/store.js';
import { getSetting, setSetting, setSecretRecord } from '../state/config-state.js';
import { encryptSecret } from '../config/crypto.js';
import { renderFlash } from './partials.js';
import { requireLogin } from './auth.js';
import { log, scrub } from '../logger.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFastify = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rep = any;

// ---------------------------------------------------------------------------
// Machine key handling (mirrors routes-secrets.ts pattern exactly)
// ---------------------------------------------------------------------------

let _machineKey: Buffer | null = null;

/**
 * Register the machine key for secret encryption in this route module.
 * Call from server startup alongside setSecretsMachineKey (see src/server.ts).
 */
export function setGithubRoutesMachineKey(key: Buffer): void {
  _machineKey = key;
}

/**
 * Get the machine key, falling back to loadMachineKey() if not pre-set.
 * Ensures production deployments work without explicit initialization.
 */
async function getMachineKey(): Promise<Buffer> {
  if (_machineKey) return _machineKey;
  const { loadMachineKey } = await import('../config/crypto.js');
  const key = loadMachineKey();
  _machineKey = key;
  return key;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Constant-time comparison of two strings (mirrors setup.ts tokensMatch).
 * Returns false for mismatched lengths without calling timingSafeEqual on
 * unequal-length buffers (which would throw).
 */
function tokensMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Derive the base URL for manifest fields.
 * Uses the persisted domain (https) when set; otherwise falls back to the
 * request scheme + host. A missing domain means HTTP over IP -- callers should
 * surface a warning to the operator.
 */
function getBaseUrl(domain: string | undefined, req: Req): string {
  if (domain) {
    return `https://${domain}`;
  }
  const host = (req.hostname as string) ?? '';
  const port = (req.port as string | undefined) ?? '';
  const portSuffix = port && port !== '80' && port !== '443' ? `:${port}` : '';
  return `${req.protocol as string}://${host}${portSuffix}`;
}

/**
 * Build the manifest JSON string for the GitHub App Manifest flow (D5-02).
 * Permissions include issues:write per 05-RESEARCH.md correction -- the summary
 * comment posts via the issues comment endpoint, not the pull_requests endpoint.
 */
function buildManifest(baseUrl: string, appName: string): string {
  const manifest = {
    name: appName,
    url: baseUrl,
    hook_attributes: {
      url: `${baseUrl}/webhook`,
      active: true,
    },
    redirect_url: `${baseUrl}/dashboard/github/callback`,
    public: false,
    default_events: ['pull_request'],
    default_permissions: {
      pull_requests: 'write',
      issues: 'write',
      contents: 'read',
      metadata: 'read',
    },
  };
  return JSON.stringify(manifest);
}

/**
 * Validate an org login for URL interpolation (T-05-07).
 * Only [A-Za-z0-9-] allowed to prevent URL injection.
 */
function isValidOrgLogin(org: string): boolean {
  return /^[A-Za-z0-9-]+$/.test(org);
}

// ---------------------------------------------------------------------------
// Route registrar
// ---------------------------------------------------------------------------

export async function registerGithubRoutes(
  fastify: AnyFastify,
  store: ConfigStore,
  _db: Database.Database,
): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /dashboard/github -- render the GitHub section partial
  // -------------------------------------------------------------------------
  fastify.get(
    '/dashboard/github',
    { preHandler: requireLogin },
    async (req: Req, reply: Rep) => {
      const connected = !!getSetting('github_app_slug');
      const csrfToken = await reply.generateCsrf();

      if (!connected) {
        return reply.code(200).viewAsync('dashboard/partials/github', {
          csrfToken,
          connected: false,
          flash: '',
        });
      }

      // Connected state: render App identity.
      // Plan 04 extends this handler with live installation/repo listing.
      const slug = getSetting('github_app_slug') ?? '';
      const appName = getSetting('github_app_name') ?? '';
      const htmlUrl = getSetting('github_app_html_url') ?? '';

      return reply.code(200).viewAsync('dashboard/partials/github', {
        csrfToken,
        connected: true,
        slug,
        appName,
        htmlUrl,
        // installations and repos are empty here; Plan 04 fills them live.
        installGroups: [],
        flash: '',
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /dashboard/github/connect -- generate state token + render manifest form
  // -------------------------------------------------------------------------
  fastify.get(
    '/dashboard/github/connect',
    { preHandler: requireLogin },
    async (req: Req, reply: Rep) => {
      // Generate a per-session state token (session-bound CSRF for the outbound
      // redirect + callback leg, D5-06). Same size as setup.ts token (48-char hex).
      const stateToken = randomBytes(24).toString('hex');
      req.session.set('githubManifestState', stateToken);
      await req.session.save();

      // Base URL: prefer configured domain (https), else request scheme/host.
      const baseUrl = getBaseUrl(store.domain, req);
      const isHttp = !store.domain && (req.protocol as string) === 'http';

      // App name: random suffix to avoid GitHub name collisions (Pitfall 2).
      const suffix = randomBytes(3).toString('hex');
      const appName = `open-review-${suffix}`;

      const manifestJson = buildManifest(baseUrl, appName);

      // Org support: an optional org query param allows creating the App under an org
      // the operator admins. Validate before URL interpolation (T-05-07).
      const query = req.query as Record<string, string | undefined>;
      const orgParam = (query['org'] ?? '').trim();
      let githubCreateUrl: string;

      if (orgParam && isValidOrgLogin(orgParam)) {
        githubCreateUrl = `https://github.com/organizations/${orgParam}/settings/apps/new?state=${stateToken}`;
      } else {
        githubCreateUrl = `https://github.com/settings/apps/new?state=${stateToken}`;
      }

      const csrfToken = await reply.generateCsrf();

      return reply.code(200).viewAsync('dashboard/partials/github', {
        csrfToken,
        connected: false,
        manifestMode: true,
        manifestJson,
        githubCreateUrl,
        isHttp,
        flash: '',
      });
    },
  );

  // -------------------------------------------------------------------------
  // GET /dashboard/github/callback -- state verify + code exchange + persist
  //
  // NOTE: NO csrfProtection preHandler here. GitHub is the caller and cannot
  // supply a synchronizer CSRF token. The session-bound state token is the
  // CSRF control for this route (D5-06, T-05-05).
  // -------------------------------------------------------------------------
  fastify.get(
    '/dashboard/github/callback',
    { preHandler: requireLogin },
    async (req: Req, reply: Rep) => {
      const query = req.query as Record<string, string | undefined>;
      const callbackState = query['state'] ?? '';
      const code = query['code'] ?? '';

      // Read the session-stored state token.
      const sessionState = req.session.get('githubManifestState') as string | undefined;

      // Constant-time state verification (T-05-05).
      const stateValid = !!sessionState && !!callbackState && tokensMatch(sessionState, callbackState);

      if (!stateValid) {
        // Clear the session state regardless (defense in depth).
        req.session.set('githubManifestState', undefined);
        await req.session.save();

        const csrfToken = await reply.generateCsrf();
        const flash = renderFlash('error', 'Invalid or expired connection request. Please try connecting again.');
        return reply.code(400).viewAsync('dashboard/partials/github', {
          csrfToken,
          connected: false,
          flash,
        });
      }

      // Clear the session state IMMEDIATELY after a valid match (replay defense, Pitfall 3,
      // T-05-06). A second callback hit will fail the state check above.
      req.session.set('githubManifestState', undefined);
      await req.session.save();

      const machineKey = await getMachineKey();

      try {
        // Exchange the one-time code via an unauthenticated Octokit (Pattern 2).
        // The code is the credential; no auth header is required or wanted here.
        const unauthOctokit = new Octokit();
        const { data } = await unauthOctokit.rest.apps.createFromManifest({ code });

        // Persist identity values to settings (non-sensitive display data).
        setSetting('github_app_id', String(data.id));
        setSetting('github_app_slug', data.slug ?? '');          // connection marker (D5-07)
        setSetting('github_app_name', data.name ?? '');
        setSetting('github_app_html_url', data.html_url ?? '');
        setSetting('github_client_id', data.client_id ?? '');

        // Persist sensitive credentials to the AES-256-GCM secrets store.
        // NEVER pass pem or client_secret to a template or a log line (T-05-08).
        setSecretRecord('github_app_private_key', encryptSecret(data.pem, machineKey));
        setSecretRecord('github_client_secret', encryptSecret(data.client_secret, machineKey));

        // webhook_secret: persist only when truthy -- the type is string | null
        // and storing null would break HMAC verification (Pitfall 1, T-05-09).
        if (data.webhook_secret) {
          setSetting('webhook_secret', data.webhook_secret);
        } else {
          log.warn(
            {},
            'github callback: webhook_secret was null in conversion response -- operator must set it manually in the Advanced section',
          );
        }

        // Redirect to the install step. The operator visits
        // https://github.com/apps/<slug>/installations/new to install on their
        // accounts/orgs; that page redirects back to the dashboard when done (D5-04).
        return reply.redirect('/dashboard/github/install');
      } catch (err: unknown) {
        // Log the error (scrubbed) without exposing credential values.
        log.error({ err: scrub(String(err)) }, 'github: callback conversion failed');
        const csrfToken = await reply.generateCsrf();
        const flash = renderFlash(
          'error',
          'GitHub connection failed. Check the logs for details. Please try connecting again.',
        );
        return reply.code(200).viewAsync('dashboard/partials/github', {
          csrfToken,
          connected: false,
          flash,
        });
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /dashboard/github/install -- redirect to the GitHub App install page
  // -------------------------------------------------------------------------
  fastify.get(
    '/dashboard/github/install',
    { preHandler: requireLogin },
    async (_req: Req, reply: Rep) => {
      const slug = getSetting('github_app_slug');
      if (!slug) {
        // App not connected yet -- send back to the GitHub section.
        return reply.redirect('/dashboard');
      }
      // D5-04: the GitHub App install URL lets the operator select personal/org targets.
      return reply.redirect(`https://github.com/apps/${slug}/installations/new`);
    },
  );
}
