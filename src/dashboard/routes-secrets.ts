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
 *   webhookSecret       -> settings.webhook_secret  (non-secret table, plain setting)
 *   claudeOauthToken    -> secrets.claude_oauth_token
 *   anthropicApiKey     -> secrets.anthropic_api_key
 *   githubAppId         -> secrets.github_app_id
 *   githubAppPrivateKey -> secrets.github_app_private_key
 *   githubToken         -> secrets.github_token
 *
 * Note: webhookSecret is stored in the settings table (not encrypted) because it is
 * compared on every webhook request and encrypting it would add overhead on the hot path.
 * The plan's "write-only preserve" rule still applies: blank submission leaves it unchanged.
 */

import type Database from 'better-sqlite3';
import type { ConfigStore } from '../config/store.js';
import { setSetting, setSecretRecord, getSecretRecord } from '../state/config-state.js';
import { encryptSecret, decryptSecret, maskSecret } from '../config/crypto.js';
import { renderFlash } from './partials.js';
import { requireLogin } from './auth.js';
import { log, scrub } from '../logger.js';

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
        // webhookSecret: stored as a plain setting (not in secrets table).
        const webhookSecret = body['webhookSecret'];
        if (webhookSecret && webhookSecret.trim() !== '') {
          setSetting('webhook_secret', webhookSecret.trim());
        }

        // Encrypted secret fields: each is stored with setSecretRecord.
        const secretFields: Array<[string, string]> = [
          ['claudeOauthToken', 'claude_oauth_token'],
          ['anthropicApiKey', 'anthropic_api_key'],
          ['githubAppId', 'github_app_id'],
          ['githubAppPrivateKey', 'github_app_private_key'],
          ['githubToken', 'github_token'],
        ];

        // Token fields are whitespace-free by definition (T-jr6-03).
        // Strip ALL internal whitespace on save so a corrupted-on-copy token with
        // stray spaces cannot quietly break auth (reproduces the live 401 incident).
        // github_app_private_key is a PEM with legitimate newlines and internal spaces
        // and is explicitly excluded from stripping -- only trim() applies to it.
        const WHITESPACE_FREE_FIELDS = new Set([
          'claudeOauthToken',
          'anthropicApiKey',
          'githubAppId',
          'githubToken',
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
          ...buildSecretsViewData(store, machineKey),
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
          ...buildSecretsViewData(store, machineKey),
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
function buildSecretsViewData(store: ConfigStore, machineKey: Buffer): Record<string, unknown> {
  // Webhook secret is in the settings table (plain text).
  // WR-02: the webhook HMAC secret is a pure shared secret (not a token whose trailing
  // digits aid identification), so show a presence indicator rather than leaking its
  // last 4 characters back to the browser. maskSecret last-4 is reserved for OAuth/API
  // tokens below, where the trailing chars are a deliberate identification aid.
  const webhookSecretVal = store.webhookSecret;
  const webhookSecretPreview = webhookSecretVal ? '(set)' : null;

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
  const githubAppIdPreview = previewSecret('github_app_id');
  const githubTokenPreview = previewSecret('github_token', 'ghp_');

  // Private key: show (PEM key set) or (not set) -- never a masked preview.
  const hasPrivateKey = !!getSecretRecord('github_app_private_key');

  return {
    webhookSecretPreview,
    claudeOauthPreview,
    anthropicApiKeyPreview,
    githubAppIdPreview,
    githubTokenPreview,
    hasPrivateKey,
    flash: '',
  };
}
