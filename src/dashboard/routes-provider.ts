/**
 * Provider section route (DCFG-04).
 *
 * Fills the body of the registerProviderRoutes stub created by Plan 02.
 * Already imported and called by routes.ts -- do NOT modify routes.ts.
 *
 * POST /dashboard/settings/provider
 *   - Auth: requireLogin (preHandler) + csrfProtection (preHandler)
 *   - Validates: only 'claude' is selectable in Phase 2 (Codex disabled, D2-12)
 *   - On 'claude': persists via setSetting('provider','claude'), re-renders with success flash
 *   - On any other value: re-renders unchanged with no mutation
 *   - hx-target="#provider-section" hx-swap="outerHTML"
 */

import type Database from 'better-sqlite3';
import type { ConfigStore } from '../config/store.js';
import { setSetting } from '../state/config-state.js';
import { maskSecret } from '../config/crypto.js';
import { renderFlash } from './partials.js';
import { requireLogin } from './auth.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFastify = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rep = any;

export async function registerProviderRoutes(
  fastify: AnyFastify,
  store: ConfigStore,
  _db: Database.Database,
): Promise<void> {
  fastify.post(
    '/dashboard/settings/provider',
    { preHandler: [requireLogin, fastify.csrfProtection] },
    async (req: Req, reply: Rep) => {
      const body = req.body as Record<string, string | undefined>;
      const requested = body['provider'] ?? '';

      const csrfToken = await reply.generateCsrf();

      // Only 'claude' is selectable in Phase 2. Codex is present-but-disabled (D2-12).
      if (requested !== 'claude') {
        // Reject: re-render unchanged with no success flash and no mutation.
        const flash = renderFlash('error', 'Selected provider is not available.');
        return reply.code(200).viewAsync('dashboard/partials/provider', {
          ...buildProviderViewData(store),
          csrfToken,
          flash,
        });
      }

      // Persist the selection via live store (DCFG-05: no restart required).
      setSetting('provider', 'claude');

      const flash = renderFlash('success', 'Provider saved.');
      return reply.code(200).viewAsync('dashboard/partials/provider', {
        ...buildProviderViewData(store),
        csrfToken,
        flash,
      });
    },
  );
}

/**
 * Build the view data object for the provider partial.
 * Secret presence is communicated via masked previews (write-only, D2-06).
 */
function buildProviderViewData(store: ConfigStore): Record<string, unknown> {
  const oauthToken = store.claudeOauthToken;
  const apiKey = store.anthropicApiKey;

  return {
    provider: store.provider,
    claudeOauthTokenPreview: oauthToken ? maskSecret(oauthToken) : null,
    anthropicApiKeyPreview: apiKey ? maskSecret(apiKey, 'sk-ant-') : null,
    flash: '',
  };
}
