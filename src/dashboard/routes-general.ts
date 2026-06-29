/**
 * General settings section route (DCFG-01, DCFG-05).
 *
 * Fills the body of the registerGeneralRoutes stub created by Plan 02.
 * Already imported and called by routes.ts -- do NOT modify routes.ts.
 *
 * POST /dashboard/settings/general
 *   - Auth: requireLogin (preHandler) + csrfProtection (preHandler)
 *   - Validates: minSeverity (SEVERITIES enum), checkboxes, ignore globs
 *   - On success: writes via setSetting, re-renders general partial with success flash
 *   - On validation error: re-renders general partial with error flash; no mutation
 *   - hx-target="#general-section" hx-swap="outerHTML"
 */

import { z } from 'zod';
import type Database from 'better-sqlite3';
import type { ConfigStore } from '../config/store.js';
import { setSetting } from '../state/config-state.js';
import { renderFlash } from './partials.js';
import { requireLogin } from './auth.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFastify = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Req = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rep = any;

// Reuse the SEVERITIES tuple from store.ts -- do not redefine.
const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

const GeneralFormSchema = z.object({
  minSeverity: z.enum(SEVERITIES, {
    errorMap: () => ({
      message: 'Minimum severity must be one of: low, medium, high, critical.',
    }),
  }),
  // Checkboxes: present = 'on', absent = undefined. Coerce to boolean.
  skipDrafts: z
    .string()
    .optional()
    .transform((v) => v === 'on'),
  skipForks: z
    .string()
    .optional()
    .transform((v) => v === 'on'),
  // Globs: textarea; split on newlines, trim, drop empty lines.
  ignoreGlobs: z.string().optional().default(''),
});

export async function registerGeneralRoutes(
  fastify: AnyFastify,
  store: ConfigStore,
  _db: Database.Database,
): Promise<void> {
  fastify.post(
    '/dashboard/settings/general',
    { preHandler: [requireLogin, fastify.csrfProtection] },
    async (req: Req, reply: Rep) => {
      const body = req.body as Record<string, string | undefined>;

      const parsed = GeneralFormSchema.safeParse(body);
      if (!parsed.success) {
        const firstError = parsed.error.errors[0];
        const message = firstError?.message ?? 'Invalid input.';
        const flash = renderFlash('error', message);
        const csrfToken = await reply.generateCsrf();
        return reply.code(200).viewAsync('dashboard/partials/general', {
          ...buildGeneralViewData(store),
          csrfToken,
          flash,
        });
      }

      const { minSeverity, skipDrafts, skipForks, ignoreGlobs } = parsed.data;

      // Parse globs: split on newlines, trim, drop blanks.
      const globLines = ignoreGlobs
        .split('\n')
        .map((g) => g.trim())
        .filter(Boolean);

      // Write through setSetting (DCFG-05: live propagation).
      setSetting('min_severity', minSeverity);
      setSetting('skip_drafts', String(skipDrafts));
      setSetting('skip_forks', String(skipForks));
      setSetting('ignore_globs', JSON.stringify(globLines.length > 0 ? globLines : store.ignoreGlobs));

      const csrfToken = await reply.generateCsrf();
      const flash = renderFlash('success', 'Settings saved.');
      return reply.code(200).viewAsync('dashboard/partials/general', {
        ...buildGeneralViewData(store),
        csrfToken,
        flash,
      });
    },
  );
}

/** Build the view data object for the general partial from the live store. */
function buildGeneralViewData(store: ConfigStore): Record<string, unknown> {
  return {
    minSeverity: store.minSeverity,
    skipDrafts: store.skipDrafts,
    skipForks: store.skipForks,
    ignoreGlobs: store.ignoreGlobs.join('\n'),
    flash: '',
  };
}
