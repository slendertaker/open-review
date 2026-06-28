/**
 * ConfigStore interface and env-backed implementation (D-18).
 *
 * Phase 1 reads all config from environment variables. Phase 2 will swap in
 * a SQLite-backed store (dashboard-managed) with zero consumer changes.
 *
 * Env var names accepted (with precedence order, first defined wins):
 *   Webhook secret: OPEN_REVIEW_WEBHOOK_SECRET, WEBHOOK_SECRET
 *   Claude OAuth:   CLAUDE_CODE_OAUTH_TOKEN
 *   Anthropic key:  ANTHROPIC_API_KEY
 *   GitHub PAT:     GITHUB_TOKEN
 *   GitHub App:     GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_PRIVATE_KEY_PATH
 *   Repo allowlist: OPEN_REVIEW_REPOS (comma-separated)
 *   Min severity:   OPEN_REVIEW_MIN_SEVERITY (low|medium|high|critical)
 *   Skip drafts:    OPEN_REVIEW_SKIP_DRAFTS (true|false, default true)
 *   Skip forks:     OPEN_REVIEW_SKIP_FORKS (true|false, default true)
 *   Log level:      OPEN_REVIEW_LOG_LEVEL (default: info)
 *   DB path:        OPEN_REVIEW_DB_PATH (default: data/open-review.db)
 *   Port:           OPEN_REVIEW_PORT (default: 3000)
 *   Host:           OPEN_REVIEW_HOST (default: 127.0.0.1)
 *   Ignore globs:   OPEN_REVIEW_IGNORE_GLOBS (comma-separated, default: DEFAULT_IGNORE_GLOBS)
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Default set of path globs to exclude from the diff before review.
 * Covers lockfiles, vendored deps (deep globs), and generated/build output.
 * All use double-star-slash prefix so they match at ANY depth.
 */
export const DEFAULT_IGNORE_GLOBS: string[] = [
  '**/package-lock.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/Cargo.lock',
  '**/poetry.lock',
  '**/go.sum',
  '**/*.lock',
  'node_modules/**',
  'vendor/**',
  'third_party/**',
  'dist/**',
  'build/**',
  '**/*.min.js',
  '**/*.map',
];

export type MinSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * ConfigStore interface (D-18 seam).
 * Phase 2 swaps the backing store with no changes to consumers.
 */
export interface ConfigStore {
  /** HMAC secret for GitHub webhook verification. */
  readonly webhookSecret: string;
  /** Claude subscription OAuth token (primary auth). */
  readonly claudeOauthToken: string | undefined;
  /** Anthropic API key (fallback auth). */
  readonly anthropicApiKey: string | undefined;
  /** GitHub PAT for posting reviews (single-repo fallback). */
  readonly githubToken: string | undefined;
  /** GitHub App ID (App mode). */
  readonly githubAppId: string | undefined;
  /** GitHub App private key PEM (App mode). */
  readonly githubAppPrivateKey: string | undefined;
  /** Repo allowlist; empty = allow all repos the App is installed on. */
  readonly repos: string[];
  /** Minimum finding severity to post. */
  readonly minSeverity: MinSeverity;
  /** Skip draft PRs. */
  readonly skipDrafts: boolean;
  /** Skip fork PRs. */
  readonly skipForks: boolean;
  /** Pino log level. */
  readonly logLevel: string;
  /** SQLite database path. */
  readonly dbPath: string;
  /** Fastify port. */
  readonly port: number;
  /** Fastify host. */
  readonly host: string;
  /** Diff ignore globs (git pathspec + picomatch). */
  readonly ignoreGlobs: string[];
}

// ---------------------------------------------------------------------------
// Env-backed implementation
// ---------------------------------------------------------------------------

const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;

const EnvSchema = z.object({
  webhookSecret: z.string().min(1, 'Webhook secret must not be blank'),
});

function readEnv(name: string): string | undefined {
  const v = process.env[name];
  return v !== undefined && v.trim() !== '' ? v : undefined;
}

function parseBool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined) return fallback;
  return v.toLowerCase() !== 'false' && v !== '0';
}

/**
 * D-14: default suppresses the lowest tier (low). Operators who want every
 * finding (including low) must explicitly set OPEN_REVIEW_MIN_SEVERITY=low.
 */
const DEFAULT_MIN_SEVERITY: MinSeverity = 'medium';

function parseMinSeverityEnv(v: string | undefined): MinSeverity {
  if (v === undefined) return DEFAULT_MIN_SEVERITY;
  if ((SEVERITIES as readonly string[]).includes(v)) return v as MinSeverity;
  throw new Error(`Invalid min severity '${v}' -- must be one of: ${SEVERITIES.join(', ')}`);
}

/**
 * Env-backed ConfigStore implementation.
 * Validates required keys with zod; fails fast on missing WEBHOOK_SECRET.
 */
export class EnvConfigStore implements ConfigStore {
  readonly webhookSecret: string;
  readonly claudeOauthToken: string | undefined;
  readonly anthropicApiKey: string | undefined;
  readonly githubToken: string | undefined;
  readonly githubAppId: string | undefined;
  readonly githubAppPrivateKey: string | undefined;
  readonly repos: string[];
  readonly minSeverity: MinSeverity;
  readonly skipDrafts: boolean;
  readonly skipForks: boolean;
  readonly logLevel: string;
  readonly dbPath: string;
  readonly port: number;
  readonly host: string;
  readonly ignoreGlobs: string[];

  constructor() {
    // Accept OPEN_REVIEW_WEBHOOK_SECRET or WEBHOOK_SECRET (legacy compatibility).
    const rawSecret = readEnv('OPEN_REVIEW_WEBHOOK_SECRET') ?? readEnv('WEBHOOK_SECRET');
    const parsed = EnvSchema.safeParse({ webhookSecret: rawSecret });
    if (!parsed.success) {
      throw new Error(
        'OPEN_REVIEW_WEBHOOK_SECRET (or WEBHOOK_SECRET) is required but not set or is blank',
      );
    }
    this.webhookSecret = parsed.data.webhookSecret;

    this.claudeOauthToken = readEnv('CLAUDE_CODE_OAUTH_TOKEN');
    this.anthropicApiKey = readEnv('ANTHROPIC_API_KEY');
    this.githubToken = readEnv('GITHUB_TOKEN');
    this.githubAppId = readEnv('GITHUB_APP_ID');

    // GitHub App private key: inline PEM (env) or file path.
    let appKey = readEnv('GITHUB_APP_PRIVATE_KEY');
    if (!appKey) {
      const keyPath = readEnv('GITHUB_APP_PRIVATE_KEY_PATH');
      if (keyPath) appKey = readFileSync(keyPath, 'utf8');
    }
    // Tolerate single-line env values where newlines were escaped as "\n".
    if (appKey?.includes('\\n')) {
      appKey = appKey.replace(/\\n/g, '\n');
    }
    this.githubAppPrivateKey = appKey;

    // Repo allowlist: comma-separated, empty string = allow all.
    const repoEnv = readEnv('OPEN_REVIEW_REPOS');
    this.repos = repoEnv
      ? repoEnv.split(',').map((r) => r.trim()).filter(Boolean)
      : [];

    this.minSeverity = parseMinSeverityEnv(readEnv('OPEN_REVIEW_MIN_SEVERITY'));
    this.skipDrafts = parseBool(readEnv('OPEN_REVIEW_SKIP_DRAFTS'), true);
    this.skipForks = parseBool(readEnv('OPEN_REVIEW_SKIP_FORKS'), true);
    this.logLevel = readEnv('OPEN_REVIEW_LOG_LEVEL') ?? 'info';
    this.dbPath = readEnv('OPEN_REVIEW_DB_PATH') ?? 'data/open-review.db';
    this.port = Number(readEnv('OPEN_REVIEW_PORT') ?? '3000');
    this.host = readEnv('OPEN_REVIEW_HOST') ?? '127.0.0.1';

    const globEnv = readEnv('OPEN_REVIEW_IGNORE_GLOBS');
    this.ignoreGlobs = globEnv
      ? globEnv.split(',').map((g) => g.trim()).filter(Boolean)
      : DEFAULT_IGNORE_GLOBS;
  }
}
