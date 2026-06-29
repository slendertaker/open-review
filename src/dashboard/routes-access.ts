/**
 * Access section routes: change password (DSEC-01) and domain (DSEC-02, DCFG-01).
 *
 * Already imported and called by routes.ts (Plan 02 stub). Do NOT modify routes.ts.
 *
 * POST /dashboard/settings/password
 *   - Validates current password via argon2.verify (T-02-20 elevation-of-privilege mitigation)
 *   - Enforces new password >= 12 chars and confirm match
 *   - On success: replaces hash via setSetting, keeps session authenticated (DSEC-01)
 *   - On failure: returns exact UI-SPEC error flash; hash unchanged
 *
 * POST /dashboard/settings/domain
 *   - Validates bare hostname (no scheme, no trailing slash, no whitespace)
 *   - Persists via setSetting('domain', ...); empty value clears (IP-only mode)
 *   - store.domain reads live after next getter call (DCFG-05 live propagation)
 *   - Caddy provisioning deferred to Phase 4 (D2-11)
 */

import argon2 from 'argon2';
import type Database from 'better-sqlite3';
import type { ConfigStore } from '../config/store.js';
import { getSetting, setSetting, deleteSetting } from '../state/config-state.js';
import { deleteAllSessionsExcept } from '../state/sessions.js';
import { renderFlash } from './partials.js';
import { requireLogin } from './auth.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFastify = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rep = any;

export async function registerAccessRoutes(
  fastify: AnyFastify,
  store: ConfigStore,
  db: Database.Database,
): Promise<void> {
  // -------------------------------------------------------------------------
  // POST /dashboard/settings/password -- change dashboard password (DSEC-01)
  // T-02-21: CSRF via preHandler; T-02-20: requires correct current password
  // -------------------------------------------------------------------------
  fastify.post(
    '/dashboard/settings/password',
    { preHandler: [requireLogin, fastify.csrfProtection] },
    async (req: Req, reply: Rep) => {
      const body = req.body as Record<string, string>;
      const currentPassword = body['currentPassword'] ?? '';
      const newPassword = body['newPassword'] ?? '';
      const confirmPassword = body['confirmPassword'] ?? '';

      // Read stored hash -- must exist (a password is always set when the dashboard is reachable).
      const storedHash = getSetting('password_hash') ?? '';

      // Verify current password (T-02-20: elevation-of-privilege mitigation).
      let currentValid = false;
      try {
        currentValid = await argon2.verify(storedHash, currentPassword);
      } catch {
        // Unexpected verify error -- treat as wrong password.
        currentValid = false;
      }

      const csrfToken = await reply.generateCsrf();

      if (!currentValid) {
        const flash = renderFlash('error', 'Current password is incorrect.');
        return reply.code(200).viewAsync('dashboard/partials/access', {
          csrfToken,
          domain: store.domain ?? '',
          flash,
          domainFlash: '',
        });
      }

      // Enforce new password length >= 12.
      if (newPassword.length < 12) {
        const flash = renderFlash('error', 'New password must be at least 12 characters.');
        return reply.code(200).viewAsync('dashboard/partials/access', {
          csrfToken,
          domain: store.domain ?? '',
          flash,
          domainFlash: '',
        });
      }

      // Enforce confirm match.
      if (newPassword !== confirmPassword) {
        const flash = renderFlash('error', 'Passwords do not match.');
        return reply.code(200).viewAsync('dashboard/partials/access', {
          csrfToken,
          domain: store.domain ?? '',
          flash,
          domainFlash: '',
        });
      }

      // Hash new password (argon2id, T-02-22: plaintext never stored).
      const newHash = await argon2.hash(newPassword, { type: argon2.argon2id });
      setSetting('password_hash', newHash);

      // Revoke all OTHER sessions (WR-01): password rotation is the operator's
      // "I may be compromised / lost a device" lever, so every previously-issued
      // session cookie must stop working immediately rather than living out its
      // 24h TTL. The current session is preserved by id so the operator remains
      // signed in (DSEC-01).
      deleteAllSessionsExcept(db, req.session.sessionId);

      // Session stays authenticated -- do NOT destroy or regenerate. The operator
      // remains signed in after a successful password rotation (DSEC-01, must_haves).

      const flash = renderFlash('success', 'Password changed. You remain signed in.');
      return reply.code(200).viewAsync('dashboard/partials/access', {
        csrfToken,
        domain: store.domain ?? '',
        flash,
        domainFlash: '',
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /dashboard/settings/domain -- persist domain setting (DSEC-02, DCFG-01)
  // T-02-21: CSRF via preHandler; T-02-23: bare-hostname validation
  // -------------------------------------------------------------------------
  fastify.post(
    '/dashboard/settings/domain',
    { preHandler: [requireLogin, fastify.csrfProtection] },
    async (req: Req, reply: Rep) => {
      const body = req.body as Record<string, string>;
      const rawDomain = (body['domain'] ?? '').trim();

      const csrfToken = await reply.generateCsrf();

      // Validate: reject any scheme, trailing slash, or whitespace (T-02-23).
      // An empty value is allowed (clears the domain, IP-only mode).
      if (rawDomain.length > 0) {
        if (rawDomain.includes('://') || rawDomain.endsWith('/') || /\s/.test(rawDomain)) {
          const domainFlash = renderFlash(
            'error',
            'Enter a plain domain name without https:// or a trailing slash.',
          );
          return reply.code(200).viewAsync('dashboard/partials/access', {
            csrfToken,
            domain: store.domain ?? '',
            flash: '',
            domainFlash,
          });
        }
      }

      // Persist. Empty input clears the domain by DELETING the row (WR-07), so
      // store.domain is undefined because the row is absent -- no reliance on the
      // getter's empty-string sentinel.
      if (rawDomain === '') {
        deleteSetting('domain');
      } else {
        setSetting('domain', rawDomain);
      }

      const domainFlash = renderFlash(
        'success',
        'Domain saved. Configure Caddy with this domain to enable HTTPS.',
      );
      return reply.code(200).viewAsync('dashboard/partials/access', {
        csrfToken,
        domain: store.domain ?? '',
        flash: '',
        domainFlash,
      });
    },
  );
}
