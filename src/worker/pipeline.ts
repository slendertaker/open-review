/**
 * Review pipeline orchestration (ENGN-02..06, SC5).
 *
 * runReview orchestrates:
 *   1. Resolve GitHub auth token (App or PAT).
 *   2. acquireWorktree (bare clone cache + ephemeral worktree at headSha).
 *   3. getDiff (base...head with ignore globs).
 *   4. readProjectGuidelines (untrusted data wrapped in prompt).
 *   5. buildPrompt (D-15 injection guard).
 *   6. provider.invoke (D-05, D-06, D-09, D-10) -- dispatched via getProvider() (D-03).
 *   7. provider.parseOutput (three shapes, never throws).
 *   8. Fingerprint dedup + min-severity filter.
 *   9. postReview (inline + summary).
 *  10. recordPostedFingerprints + setLastReviewedSha.
 *
 * SC5: releaseWorktree is called in a finally block on EVERY exit path
 *   (success, error, timeout, rate-limit). Cleanup errors are caught+logged,
 *   never rethrown, so the original error propagates correctly.
 */

import { buildLogger, scrub } from '../logger.js';
import type { ConfigStore } from '../config/store.js';
import type { JobPayload, JobResult } from '../queue/types.js';
import type { RawOutput } from '../provider/types.js';
import {
  acquireWorktree,
  releaseWorktree,
  getDiff,
  isAncestor,
  readProjectGuidelines,
} from './repo.js';
import { buildDiffMap } from './diff.js';
import { buildPrompt } from './prompt.js';
import { getProvider } from '../provider/index.js';
import { ClaudeProvider } from '../provider/claude.js';
import { fingerprintFinding, meetsMinSeverity } from '../provider/parser.js';
import { postReview } from '../poster/post.js';
import {
  getLastReviewedSha,
  setLastReviewedSha,
  getPostedFingerprints,
  recordPostedFingerprints,
} from '../state/reviews.js';
import { installationOctokit, installationToken } from '../github/app.js';

/**
 * Assert that the provider subprocess succeeded (exit code 0).
 * Throws a scrubbed, bounded error message on non-zero exit so the pipeline
 * fails before any parsing, dedup, or postReview happens (T-jr6-01).
 *
 * RateLimitError (exit 29) is thrown earlier inside the provider (checkRateLimit)
 * and never reaches this guard. This guard catches all other non-zero exits,
 * including 401 authentication failures with empty stdout.
 *
 * Exported for unit tests.
 */
export function assertProviderSucceeded(out: RawOutput): void {
  if (out.exitCode === 0) return;
  // Prefer stderr when it has non-whitespace content; fall back to stdout.
  const raw = out.stderr.trim() ? out.stderr : out.stdout;
  // Bound to the last 2000 characters before scrubbing.
  const tail = raw.length > 2000 ? raw.slice(-2000) : raw;
  const scrubbedTail = scrub(tail.trim() || '(no output)');
  throw new Error(`review runner failed: provider exited with code ${out.exitCode}: ${scrubbedTail}`);
}

/**
 * Build a scrubbed, bounded log string for durable storage (D3-04, T-jr6-02).
 * Replaces the previous `String(out ?? '')` construction that always produced
 * "[object Object]" because out is a RawOutput object.
 *
 * Exported for unit tests.
 */
export function formatRunLog(logMeta: string, out: RawOutput): string {
  const stdoutTail = out.stdout.length > 2000 ? out.stdout.slice(-2000) : out.stdout;
  let result = `${logMeta}\nexit=${out.exitCode}\n${stdoutTail}`;
  if (out.stderr.trim()) {
    const stderrTail = out.stderr.length > 2000 ? out.stderr.slice(-2000) : out.stderr;
    result += `\nstderr: ${stderrTail}`;
  }
  return scrub(result);
}

const log = buildLogger(process.env['OPEN_REVIEW_LOG_LEVEL'] ?? 'info');

/**
 * Run a full review for the given job payload.
 *
 * Throws on missing GitHub auth or runner errors so the queue can handle them.
 * postReview is wrapped in log-and-drop (in post.ts) so posting failures never
 * disturb the SC5 worktree cleanup guarantee.
 */
export async function runReview(job: JobPayload, config: ConfigStore): Promise<JobResult> {
  const provider = getProvider(config.provider);

  // Resolve Claude credentials from the live store with D-05 precedence:
  //   1. store.claudeOauthToken (primary OAuth)
  //   2. store.anthropicApiKey (API key fallback)
  //   3. process.env (last-resort for Phase 1 env-only installs -- no restart required)
  // The resolved values are passed into provider.invoke so the subprocess never
  // reads credentials directly from process.env (T-02-18, DCFG-05).
  const resolvedOauthToken = config.claudeOauthToken;
  const resolvedApiKey = config.anthropicApiKey;

  // Step 1: Resolve GitHub auth (App mode only -- the GitHub App connect flow
  // is the sole auth path; see D5 series).
  if (
    !config.githubAppId ||
    !config.githubAppPrivateKey ||
    job.installationId === undefined
  ) {
    throw new Error(
      'No GitHub auth available: connect the GitHub App from the dashboard',
    );
  }

  const creds = { appId: config.githubAppId, privateKey: config.githubAppPrivateKey };
  const githubToken = await installationToken(creds, job.installationId);
  const octokit = installationOctokit(creds, job.installationId);

  const { wtDir, bareDir } = await acquireWorktree(
    job.owner,
    job.repo,
    job.headSha,
    githubToken,
  );

  try {
    const prId = `${job.owner}/${job.repo}#${job.prNumber}`;

    // Effective per-repo severity/ignore-globs, merging any repo_settings
    // override with the global defaults.
    const repoConfig = config.repoConfig(`${job.owner}/${job.repo}`);

    // Step 3: Incremental vs full review (INCR-01).
    const lastSha = getLastReviewedSha(prId);
    const incremental =
      lastSha !== null && (await isAncestor(bareDir, lastSha, job.headSha));
    const diffBase = incremental ? (lastSha as string) : job.baseSha;

    const diff = await getDiff(bareDir, diffBase, job.headSha, repoConfig.ignoreGlobs);
    const guidelines = await readProjectGuidelines(wtDir);

    const prompt = buildPrompt(diff, job, wtDir, {
      incremental,
      ...(guidelines ? { guidelines } : {}),
    });

    // Pass store-resolved credentials to the Claude provider so the review subprocess
    // uses the live stored credential (DCFG-05). invokeResolved is a ClaudeProvider-
    // specific method; the generic interface invoke() is used for other providers.
    const out = await (provider instanceof ClaudeProvider
      ? provider.invokeResolved(prompt, wtDir, resolvedOauthToken, resolvedApiKey)
      : provider.invoke(prompt, wtDir));
    // Trust-critical gate (T-jr6-01): a non-zero exit means the subprocess failed
    // (e.g. 401 auth error). Throw before parsing so nothing is posted to GitHub
    // and src/index.ts records status='failed' with the scrubbed error message.
    assertProviderSucceeded(out);
    const parsed = provider.parseOutput(out);

    // Step 8: Fingerprint dedup + min-severity filter.
    const seen = getPostedFingerprints(prId);
    const freshFindings = parsed.findings
      .filter((f) => !seen.has(fingerprintFinding(f)))
      .filter((f) => meetsMinSeverity(f.severity, repoConfig.minSeverity));

    log.info(
      {
        repo: `${job.owner}/${job.repo}`,
        prNumber: job.prNumber,
        mode: incremental ? 'incremental' : 'full',
        guidelines: guidelines?.file ?? null,
        findingCount: parsed.findings.length,
        freshCount: freshFindings.length,
      },
      'review complete',
    );

    // Step 9: Post review.
    const diffMap = buildDiffMap(diff);
    await postReview({
      octokit,
      owner: job.owner,
      repo: job.repo,
      pullNumber: job.prNumber,
      commitId: job.headSha,
      findings: freshFindings,
      summary: parsed.summary,
      diffMap,
      ignoreGlobs: repoConfig.ignoreGlobs,
    });

    // Step 10: Record state after successful review+post.
    recordPostedFingerprints(prId, freshFindings.map(fingerprintFinding));
    setLastReviewedSha(prId, job.headSha);

    // Build a scrubbed, bounded log string for durable storage (D3-04, T-jr6-02).
    // formatRunLog captures the real exit code + stdout/stderr instead of the
    // previous String(out) which always produced "[object Object]".
    const logMeta = JSON.stringify({
      repo: `${job.owner}/${job.repo}`,
      prNumber: job.prNumber,
      mode: incremental ? 'incremental' : 'full',
      findingCount: parsed.findings.length,
      freshCount: freshFindings.length,
    });
    const rawLog = formatRunLog(logMeta, out);

    return {
      findings: freshFindings,
      summary: parsed.summary,
      mode: incremental ? 'incremental' : 'full',
      rawLog,
    };
  } finally {
    // SC5: cleanup runs on every exit path.
    await releaseWorktree(wtDir, bareDir).catch((err: unknown) => {
      log.error({ err: scrub(String(err)) }, 'worktree cleanup failed -- orphan may exist');
    });
  }
}
