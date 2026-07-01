/**
 * Secrets section route (DCFG-02, DCFG-05, T-02-15..T-02-19).
 *
 * Fills the body of the registerSecretsRoutes stub created by Plan 02.
 * Already imported and called by routes.ts -- do NOT modify routes.ts.
 *
 * POST /dashboard/settings/secrets
 *   - Auth: requireLogin (preHandler) + csrfProtection (preHandler)
 *   - Write-only: blank field = skip (preserve existing encrypted value, D2-06)
 *   - Non-blank field = encryptSecret + setSecretRecord
 *   - Response: re-renders secrets partial with ONLY masked previews (T-02-15, T-02-16)
 *   - No decrypted secret ever reaches the browser (DCFG-02)
 *   - hx-target="#secrets-section" hx-swap="outerHTML"
 *
 * Secret name mapping (form field -> secrets table name):
 *   claudeOauthToken    -> secrets.claude_oauth_token
 *   anthropicApiKey     -> secrets.anthropic_api_key
 *
 * GitHub credentials (App ID, private key, PAT, webhook secret) are no longer
 * enterable here -- the GitHub connect flow (routes-github.ts) is the only
 * path, and it generates and persists the webhook secret automatically.
 */

import type Database from 'better-sqlite3';
import type { ConfigStore } from '../config/store.js';
import { setSecretRecord, getSecretRecord, getSetting } from '../state/config-state.js';
import { encryptSecret, decryptSecret, maskSecret } from '../config/crypto.js';
import { renderFlash } from './partials.js';
import { requireLogin } from './auth.js';
import { log, scrub } from '../logger.js';
import { viewGlobals } from './routes.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFastify = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rep = any;

// Machine key handling: the server sets it once via setSecretsMachineKey() at startup
// (the store keeps it private by design, D2-05). getMachineKey() lazy-loads it via
// crypto.loadMachineKey() as a fallback when the setter was not called.
let _machineKey: Buffer | null = null;

/**
 * Register the machine key for secret encryption in this route module.
 * Must be called before the server handles any POST /dashboard/settings/secrets request.
 * Called by the server startup (src/server.ts or src/index.ts).
 */
export function setSecretsMachineKey(key: Buffer): void {
  _machineKey = key;
}

/**
 * Get the machine key, falling back to loadMachineKey() if not pre-set.
 * This ensures production (non-test) deployments work without explicit initialization.
 */
async function getMachineKey(): Promise<Buffer> {
  if (_machineKey) return _machineKey;
  // Lazy fallback for environments where setSecretsMachineKey was not called.
  const { loadMachineKey } = await import('../config/crypto.js');
  const key = loadMachineKey();
  _machineKey = key;
  return key;
}

export async function registerSecretsRoutes(
  fastify: AnyFastify,
  store: ConfigStore,
  _db: Database.Database,
): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /settings/secrets -- hybrid: fragment (HX-Request) or full shell
  // -------------------------------------------------------------------------
  fastify.get('/settings/secrets', { preHandler: requireLogin }, async (req: Req, reply: Rep) => {
    const csrfToken = await reply.generateCsrf(); // ALWAYS first, both paths (D-07)
    const machineKey = await getMachineKey();
    const sectionData = { ...buildSecretsViewData(machineKey), csrfToken };

    const isHtmx = req.headers['hx-request'] === 'true'
      && req.headers['hx-history-restore-request'] !== 'true';

    if (isHtmx) {
      return reply.code(200).viewAsync('dashboard/partials/secrets', sectionData);
    }

    // Pre-render partials to strings (fastify.view = string renderer, no reply.send)
    const sectionContent = await (fastify.view as (page: string, data: unknown) => Promise<string>)('dashboard/partials/secrets', sectionData);
    const sidebarContext = await (fastify.view as (page: string, data: unknown) => Promise<string>)('dashboard/partials/sidebar-context', {
      github_app_slug: getSetting('github_app_slug'),
      github_app_name: getSetting('github_app_name'),
      repos: store.repos,
    });
    return reply.viewAsync('shell', {
      ...viewGlobals(req),
      title: 'Secrets - Open Review',
      activeSection: 'secrets',
      sectionContent,
      sidebarContext,
      csrfToken,
    }, { layout: 'layout.eta' });
  });

  fastify.post(
    '/dashboard/settings/secrets',
    { preHandler: [requireLogin, fastify.csrfProtection] },
    async (req: Req, reply: Rep) => {
      const body = req.body as Record<string, string | undefined>;

      // Resolve the machine key before the try so the catch can reuse the REAL key
      // for its error re-render (WR-06) rather than an all-zero buffer that would
      // make every stored secret render as "(decryption error)".
      const machineKey = await getMachineKey();

      try {
        // Process each secret field. Write-only: blank = skip (D2-06, T-02-19).
        // Encrypted secret fields: each is stored with setSecretRecord.
        const secretFields: Array<[string, string]> = [
          ['claudeOauthToken', 'claude_oauth_token'],
          ['anthropicApiKey', 'anthropic_api_key'],
        ];

        // Token fields are whitespace-free by definition (T-jr6-03).
        // Strip ALL internal whitespace on save so a corrupted-on-copy token with
        // stray spaces cannot quietly break auth (reproduces the live 401 incident).
        const WHITESPACE_FREE_FIELDS = new Set([
          'claudeOauthToken',
          'anthropicApiKey',
        ]);

        for (const [fieldName, secretName] of secretFields) {
          const value = body[fieldName];
          if (value && value.trim() !== '') {
            const stored = WHITESPACE_FREE_FIELDS.has(fieldName)
              ? value.replace(/\s+/g, '')
              : value.trim();
            setSecretRecord(secretName, encryptSecret(stored, machineKey));
          }
          // blank = preserve existing (write-only, D2-06)
        }

        const csrfToken = await reply.generateCsrf();
        const flash = renderFlash('success', 'Secrets saved.');
        return reply.code(200).viewAsync('dashboard/partials/secrets', {
          ...buildSecretsViewData(machineKey),
          csrfToken,
          flash,
        });
      } catch (err: unknown) {
        // WR-06: log the underlying error (scrubbed) so the "Check the logs"
        // message has something to point at, and reuse the real machine key for
        // the error re-render so existing secrets still show their masked preview.
        log.error({ err: scrub(String(err)) }, 'secrets: save failed');
        const csrfToken = await reply.generateCsrf();
        const flash = renderFlash('error', 'Failed to save secrets. Check the logs for details.');
        return reply.code(200).viewAsync('dashboard/partials/secrets', {
          ...buildSecretsViewData(machineKey),
          csrfToken,
          flash,
        });
      }
    },
  );
}

/**
 * Build the view data for the secrets partial.
 *
 * SECURITY CONTRACT (T-02-15, T-02-16, DCFG-02):
 *   - All preview strings are produced by maskSecret -- never the plaintext.
 *   - The (PEM key set) / (not set) indicators are safe literal strings.
 *   - No decrypted value is placed in any rendered input's value attribute.
 */
function buildSecretsViewData(machineKey: Buffer): Record<string, unknown> {
  // Encrypted secrets: decrypt only to produce a masked preview.
  // We use getSecretRecord + decryptSecret directly to avoid mutating store.
  function previewSecret(
    name: string,
    prefix?: string,
  ): string | null {
    const record = getSecretRecord(name);
    if (!record) return null;
    try {
      const plaintext = decryptSecret(record, machineKey);
      return maskSecret(plaintext, prefix);
    } catch {
      return '(decryption error)';
    }
  }

  const claudeOauthPreview = previewSecret('claude_oauth_token');
  const anthropicApiKeyPreview = previewSecret('anthropic_api_key', 'sk-ant-');

  return {
    claudeOauthPreview,
    anthropicApiKeyPreview,
    flash: '',
  };
}
