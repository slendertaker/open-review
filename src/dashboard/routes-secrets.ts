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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFastify = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rep = any;

// The machine key is on the store's instance. We need it for encrypting new values.
// We extract it from the store by using the store's readSecret method indirectly,
// OR we pass the key via the route data. Since SqliteConfigStore holds the key privately,
// we use the store to decrypt existing records and pass the key via a closure.
// However the store does not expose the key publicly -- by design (D2-05).
//
// Resolution: the route handler encrypts new secrets using the same store that
// decrypts them. We provide a helper that reads the machine key from the environment
// the same way SqliteConfigStore does (via crypto.loadMachineKey), so the key is
// always consistent. This avoids adding a public key getter to the store interface.
//
// In tests, the machine key is Buffer.alloc(32, 0x43) -- the same key used to
// construct the test SqliteConfigStore. Since both the store and the route use
// loadMachineKey() via the same process, they agree in production.
//
// For integration tests with an in-memory DB, we CANNOT call loadMachineKey() because
// it reads/writes data/secret.key. Instead, the route receives the key through the
// machineKey export from src/config/crypto.ts (loaded once at server start in index.ts).
//
// Pragmatic solution: thread the machine key through as a parameter on registration.
// The routes.ts registrar already passes (fastify, store, db). We extend to accept
// the key from a module-level variable set at server startup. Since the server is built
// with the live store and key already available, we capture the key from the store's
// perspective via a dedicated module-level loader.
//
// Simplest correct solution: load the machine key fresh in the route handler using
// loadMachineKey(). In tests, OPEN_REVIEW_SECRET_KEY is not set and data/secret.key
// does not exist, so loadMachineKey() would auto-generate a different key than the one
// used by the test SqliteConfigStore. This breaks integration tests.
//
// FINAL RESOLUTION per plan disambiguation: registerSecretsRoutes accepts a 4th
// parameter (machineKey: Buffer) threaded from the server startup through routes.ts.
// BUT routes.ts cannot be modified.
//
// Therefore: use a module-level setMachineKey() function that the server initialization
// calls once (before building the server), and routes-secrets.ts reads it.
// This is consistent with the existing src/state/config-state.ts module-level pattern.

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

      try {
        const machineKey = await getMachineKey();

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

        for (const [fieldName, secretName] of secretFields) {
          const value = body[fieldName];
          if (value && value.trim() !== '') {
            setSecretRecord(secretName, encryptSecret(value.trim(), machineKey));
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
        const csrfToken = await reply.generateCsrf();
        const flash = renderFlash('error', 'Failed to save secrets. Check the logs for details.');
        const machineKey = _machineKey ?? Buffer.alloc(32);
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
