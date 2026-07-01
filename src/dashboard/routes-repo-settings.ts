/**
 * Per-repo settings routes: org/repo picker overview + per-repo severity/
 * ignore-globs override page. Replaces the old flat free-text repos list.
 *
 * GET  /settings/repos                     -- overview: status-dot cards + org/repo picker
 * GET  /settings/repos/:owner/:repo        -- per-repo settings page
 * POST /settings/repos/:owner/:repo        -- save enabled + severity/globs overrides
 * POST /settings/repos/:owner/:repo/toggle -- quick enable/disable from the overview cards
 *
 * Repos are discovered live from the GitHub App's installations (buildInstallGroups,
 * routes-github.ts) -- there is no free-text "add a repo" path, since in App-only
 * mode a repo the App isn't installed on can never receive webhooks anyway.
 */

import type Database from 'better-sqlite3';
import type { ConfigStore } from '../config/store.js';
import { getSetting } from '../state/config-state.js';
import { getRepoSettings, upsertRepoSettings } from '../state/repo-settings.js';
import { buildInstallGroups, type InstallGroup } from './routes-github.js';
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

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

// ---------------------------------------------------------------------------
// Machine key handling (mirrors routes-github.ts / routes-secrets.ts pattern)
// ---------------------------------------------------------------------------

let _machineKey: Buffer | null = null;

/** Register the machine key for buildInstallGroups. Call from server startup. */
export function setRepoSettingsMachineKey(key: Buffer): void {
  _machineKey = key;
}

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

/** Same char rules as GitHub owner/repo names (mirrors the old isValidRepo halves). */
function isValidSegment(value: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(value);
}

/** Trim install groups down to what the client-side org/repo picker script needs. */
function pickerGroups(groups: InstallGroup[]): Array<{ accountLogin: string; repos: Array<{ fullName: string; enabled: boolean }> }> {
  return groups.map((g) => ({ accountLogin: g.accountLogin, repos: g.repos }));
}

/** JSON-embed a value for inline <script> use, escaping '<' to prevent tag breakout. */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

async function fetchInstallGroups(store: ConfigStore): Promise<{ installGroups: InstallGroup[]; flash: string }> {
  const machineKey = await getMachineKey();
  try {
    const installGroups = await buildInstallGroups(store, machineKey);
    return { installGroups, flash: '' };
  } catch (err: unknown) {
    log.error({ err: scrub(String(err)) }, 'repos: failed to fetch installations from GitHub API');
    return {
      installGroups: [],
      flash: renderFlash('error', 'Could not reach GitHub to fetch repositories. Check your connection or try again later.'),
    };
  }
}

/** Build view data for the overview (org/repo picker + status-dot card grid). */
async function buildOverviewViewData(store: ConfigStore): Promise<Record<string, unknown>> {
  const { installGroups, flash } = await fetchInstallGroups(store);
  return {
    installGroups,
    installGroupsJson: safeJson(pickerGroups(installGroups)),
    connected: !!getSetting('github_app_slug'),
    flash,
  };
}

/** Build view data for a single repo's settings page. */
async function buildRepoViewData(store: ConfigStore, owner: string, repo: string): Promise<Record<string, unknown>> {
  const fullName = `${owner}/${repo}`;
  const row = getRepoSettings(fullName);
  const { installGroups } = await fetchInstallGroups(store);

  return {
    owner,
    repo,
    fullName,
    enabled: row?.enabled ?? false,
    minSeverity: row?.minSeverity ?? '',
    ignoreGlobs: row?.ignoreGlobs?.join('\n') ?? '',
    globalMinSeverity: store.minSeverity,
    installGroupsJson: safeJson(pickerGroups(installGroups)),
    flash: '',
  };
}

export async function registerRepoSettingsRoutes(
  fastify: AnyFastify,
  store: ConfigStore,
  _db: Database.Database,
): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /settings/repos -- overview: status-dot cards + org/repo picker
  // -------------------------------------------------------------------------
  fastify.get('/settings/repos', { preHandler: requireLogin }, async (req: Req, reply: Rep) => {
    const csrfToken = await reply.generateCsrf();
    const sectionData = { ...(await buildOverviewViewData(store)), csrfToken };

    const isHtmx = req.headers['hx-request'] === 'true'
      && req.headers['hx-history-restore-request'] !== 'true';

    if (isHtmx) {
      return reply.code(200).viewAsync('dashboard/partials/repos-overview', sectionData);
    }

    const sectionContent = await (fastify.view as (page: string, data: unknown) => Promise<string>)('dashboard/partials/repos-overview', sectionData);
    const sidebarContext = await (fastify.view as (page: string, data: unknown) => Promise<string>)('dashboard/partials/sidebar-context', {
      github_app_slug: getSetting('github_app_slug'),
      github_app_name: getSetting('github_app_name'),
      repos: store.repos,
    });
    return reply.viewAsync('shell', {
      ...viewGlobals(req),
      title: 'Repositories - Open Review',
      activeSection: 'repos',
      sectionContent,
      sidebarContext,
      csrfToken,
    }, { layout: 'layout.eta' });
  });

  // -------------------------------------------------------------------------
  // GET /settings/repos/:owner/:repo -- per-repo settings page
  // -------------------------------------------------------------------------
  fastify.get('/settings/repos/:owner/:repo', { preHandler: requireLogin }, async (req: Req, reply: Rep) => {
    const params = req.params as { owner: string; repo: string };
    const owner = decodeURIComponent(params.owner ?? '');
    const repo = decodeURIComponent(params.repo ?? '');

    if (!isValidSegment(owner) || !isValidSegment(repo)) {
      return reply.redirect('/settings/repos');
    }

    const csrfToken = await reply.generateCsrf();
    const sectionData = { ...(await buildRepoViewData(store, owner, repo)), csrfToken };

    const isHtmx = req.headers['hx-request'] === 'true'
      && req.headers['hx-history-restore-request'] !== 'true';

    if (isHtmx) {
      return reply.code(200).viewAsync('dashboard/partials/repo-detail', sectionData);
    }

    const sectionContent = await (fastify.view as (page: string, data: unknown) => Promise<string>)('dashboard/partials/repo-detail', sectionData);
    const sidebarContext = await (fastify.view as (page: string, data: unknown) => Promise<string>)('dashboard/partials/sidebar-context', {
      github_app_slug: getSetting('github_app_slug'),
      github_app_name: getSetting('github_app_name'),
      repos: store.repos,
    });
    return reply.viewAsync('shell', {
      ...viewGlobals(req),
      title: `${owner}/${repo} - Open Review`,
      activeSection: 'repos',
      sectionContent,
      sidebarContext,
      csrfToken,
    }, { layout: 'layout.eta' });
  });

  // -------------------------------------------------------------------------
  // POST /settings/repos/:owner/:repo -- save enabled + severity/globs overrides
  // -------------------------------------------------------------------------
  fastify.post(
    '/settings/repos/:owner/:repo',
    { preHandler: [requireLogin, fastify.csrfProtection] },
    async (req: Req, reply: Rep) => {
      const params = req.params as { owner: string; repo: string };
      const owner = decodeURIComponent(params.owner ?? '');
      const repo = decodeURIComponent(params.repo ?? '');

      if (!isValidSegment(owner) || !isValidSegment(repo)) {
        return reply.code(400).send({ error: 'invalid repo' });
      }

      const fullName = `${owner}/${repo}`;
      const body = req.body as Record<string, string | undefined>;
      const enabled = body['enabled'] === 'on';

      const severityRaw = (body['minSeverity'] ?? '').trim();
      const minSeverity = (SEVERITIES as readonly string[]).includes(severityRaw)
        ? (severityRaw as (typeof SEVERITIES)[number])
        : null;

      const globsRaw = (body['ignoreGlobs'] ?? '').trim();
      const ignoreGlobs = globsRaw
        ? globsRaw.split('\n').map((g) => g.trim()).filter(Boolean)
        : null;

      upsertRepoSettings(fullName, { enabled, minSeverity, ignoreGlobs });

      const csrfToken = await reply.generateCsrf();
      const flash = renderFlash('success', 'Repository settings saved.');
      return reply.code(200).viewAsync('dashboard/partials/repo-detail', {
        ...(await buildRepoViewData(store, owner, repo)),
        csrfToken,
        flash,
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /settings/repos/:owner/:repo/toggle -- quick enable/disable (overview cards)
  // Preserves any existing severity/globs override; only flips `enabled`.
  // -------------------------------------------------------------------------
  fastify.post(
    '/settings/repos/:owner/:repo/toggle',
    { preHandler: [requireLogin, fastify.csrfProtection] },
    async (req: Req, reply: Rep) => {
      const params = req.params as { owner: string; repo: string };
      const owner = decodeURIComponent(params.owner ?? '');
      const repo = decodeURIComponent(params.repo ?? '');

      if (!isValidSegment(owner) || !isValidSegment(repo)) {
        return reply.code(400).send({ error: 'invalid repo' });
      }

      const fullName = `${owner}/${repo}`;
      const body = req.body as Record<string, string | undefined>;
      const enabled = body['enabled'] === '1';

      upsertRepoSettings(fullName, { enabled });

      const csrfToken = await reply.generateCsrf();
      return reply.code(200).viewAsync('dashboard/partials/repos-overview', {
        ...(await buildOverviewViewData(store)),
        csrfToken,
      });
    },
  );
}
