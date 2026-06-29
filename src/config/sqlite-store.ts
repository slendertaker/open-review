/**
 * SQLite-backed ConfigStore implementation (D2-01, DCFG-01, DCFG-05).
 *
 * SqliteConfigStore implements the ConfigStore interface with live getters
 * that read from better-sqlite3 prepared statements on every call.
 * There is no snapshot at boot -- changing a settings row propagates to the
 * next getter call without a store reconstruction or service restart (DCFG-05).
 *
 * Boot-only fields (port, host, dbPath, logLevel) are read once from the
 * environment in the constructor -- they require a restart to change (D2-04).
 *
 * Secret fields decrypt via AES-256-GCM using the machine key (D2-05, DCFG-02).
 * They return undefined when no record exists in the secrets table.
 *
 * seedFromEnvIfEmpty(db, machineKey): one-way bootstrap that copies Phase 1
 * env var values into settings/secrets exactly once. If any settings or secrets
 * row already exists, it returns immediately (D2-02, Pitfall 4 idempotence guard).
 */

import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { ConfigStore, MinSeverity } from './store.js';
import { DEFAULT_IGNORE_GLOBS } from './store.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import {
  getSetting,
  setSetting,
  getSecretRecord,
  setSecretRecord,
  countConfigRows,
} from '../state/config-state.js';

// ---------------------------------------------------------------------------
// SqliteConfigStore
// ---------------------------------------------------------------------------

export class SqliteConfigStore implements ConfigStore {
  private readonly machineKey: Buffer;

  // Boot-only fields (D2-04): read from env once at construction time.
  readonly logLevel: string;
  readonly dbPath: string;
  readonly port: number;
  readonly host: string;

  constructor(_db: Database.Database, machineKey: Buffer) {
    this.machineKey = machineKey;
    // Boot-only -- these require a restart to change per D2-04.
    this.logLevel = process.env['OPEN_REVIEW_LOG_LEVEL'] ?? 'info';
    this.dbPath = process.env['OPEN_REVIEW_DB_PATH'] ?? 'data/open-review.db';
    this.port = Number(process.env['OPEN_REVIEW_PORT'] ?? '3000');
    this.host = process.env['OPEN_REVIEW_HOST'] ?? '127.0.0.1';
  }

  // ---- Private helpers ----

  private readSetting(key: string): string | undefined {
    return getSetting(key);
  }

  private readSecret(name: string): string | undefined {
    const record = getSecretRecord(name);
    if (!record) return undefined;
    return decryptSecret(record, this.machineKey);
  }

  // ---- Review-affecting live getters (DCFG-05: no boot snapshot) ----

  get webhookSecret(): string {
    return this.readSetting('webhook_secret') ?? '';
  }

  get repos(): string[] {
    const raw = this.readSetting('repos');
    if (!raw) return [];
    try {
      return JSON.parse(raw) as string[];
    } catch {
      return [];
    }
  }

  get minSeverity(): MinSeverity {
    const v = this.readSetting('min_severity');
    if (v === 'low' || v === 'medium' || v === 'high' || v === 'critical') return v;
    return 'medium';
  }

  get skipDrafts(): boolean {
    const v = this.readSetting('skip_drafts');
    if (v === undefined) return true;
    return v.toLowerCase() !== 'false' && v !== '0';
  }

  get skipForks(): boolean {
    const v = this.readSetting('skip_forks');
    if (v === undefined) return true;
    return v.toLowerCase() !== 'false' && v !== '0';
  }

  get ignoreGlobs(): string[] {
    const raw = this.readSetting('ignore_globs');
    if (!raw) return DEFAULT_IGNORE_GLOBS;
    try {
      return JSON.parse(raw) as string[];
    } catch {
      // Legacy comma-separated format fallback
      return raw.split(',').map((g) => g.trim()).filter(Boolean);
    }
  }

  get provider(): string {
    return this.readSetting('provider') ?? 'claude';
  }

  get domain(): string | undefined {
    const v = this.readSetting('domain');
    // Treat empty string as absent (IP-only mode; stored by the Access domain-clear handler).
    return v === undefined || v === '' ? undefined : v;
  }

  get sessionSecret(): string {
    return this.readSetting('session_secret') ?? '';
  }

  // ---- Secret live getters (decrypt on each call) ----

  get claudeOauthToken(): string | undefined {
    return this.readSecret('claude_oauth_token');
  }

  get anthropicApiKey(): string | undefined {
    return this.readSecret('anthropic_api_key');
  }

  get githubToken(): string | undefined {
    return this.readSecret('github_token');
  }

  get githubAppId(): string | undefined {
    return this.readSecret('github_app_id');
  }

  get githubAppPrivateKey(): string | undefined {
    return this.readSecret('github_app_private_key');
  }
}

// ---------------------------------------------------------------------------
// seedFromEnvIfEmpty (D2-02)
// ---------------------------------------------------------------------------

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '' ? v : undefined;
}

function parseBoolStr(v: string | undefined, fallback: boolean): string {
  if (v === undefined) return String(fallback);
  const parsed = v.toLowerCase() !== 'false' && v !== '0';
  return String(parsed);
}

/**
 * One-way bootstrap: copy Phase 1 env var values into settings + secrets tables.
 *
 * Guard: if any settings or secrets row already exists, return immediately
 * without touching any rows (Pitfall 4 idempotence -- D2-02 "env vars are
 * bootstrap seed only"). This means calling seedFromEnvIfEmpty again after the
 * operator has configured the dashboard is always a safe no-op.
 */
export function seedFromEnvIfEmpty(db: Database.Database, machineKey: Buffer): void {
  // Idempotence guard -- any existing row means bootstrap already ran.
  if (countConfigRows() > 0) return;

  // Seed settings
  const webhookSecret =
    readEnv('OPEN_REVIEW_WEBHOOK_SECRET') ?? readEnv('WEBHOOK_SECRET');
  if (webhookSecret) setSetting('webhook_secret', webhookSecret);

  const reposEnv = readEnv('OPEN_REVIEW_REPOS');
  if (reposEnv) {
    const repos = reposEnv.split(',').map((r) => r.trim()).filter(Boolean);
    setSetting('repos', JSON.stringify(repos));
  }

  const minSev = readEnv('OPEN_REVIEW_MIN_SEVERITY');
  if (minSev) setSetting('min_severity', minSev);

  setSetting('skip_drafts', parseBoolStr(readEnv('OPEN_REVIEW_SKIP_DRAFTS'), true));
  setSetting('skip_forks', parseBoolStr(readEnv('OPEN_REVIEW_SKIP_FORKS'), true));

  const globEnv = readEnv('OPEN_REVIEW_IGNORE_GLOBS');
  if (globEnv) {
    const globs = globEnv.split(',').map((g) => g.trim()).filter(Boolean);
    setSetting('ignore_globs', JSON.stringify(globs));
  }

  // Seed secrets (encrypt with machine key)
  function seedSecret(envName: string, secretName: string): void {
    const val = readEnv(envName);
    if (val) setSecretRecord(secretName, encryptSecret(val, machineKey));
  }

  seedSecret('CLAUDE_CODE_OAUTH_TOKEN', 'claude_oauth_token');
  seedSecret('ANTHROPIC_API_KEY', 'anthropic_api_key');
  seedSecret('GITHUB_TOKEN', 'github_token');
  seedSecret('GITHUB_APP_ID', 'github_app_id');
  seedSecret('GITHUB_APP_PRIVATE_KEY', 'github_app_private_key');

  // GitHub App private key file path fallback
  if (!readEnv('GITHUB_APP_PRIVATE_KEY')) {
    const keyPath = readEnv('GITHUB_APP_PRIVATE_KEY_PATH');
    if (keyPath) {
      try {
        let pem = readFileSync(keyPath, 'utf8');
        if (pem.includes('\\n')) pem = pem.replace(/\\n/g, '\n');
        setSecretRecord('github_app_private_key', encryptSecret(pem, machineKey));
      } catch {
        // Key file not readable -- skip silently; operator must configure via dashboard
      }
    }
  }
}
