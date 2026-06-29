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
import { fingerprintFinding, meetsMinSeverity } from '../provider/parser.js';
import { postReview } from '../poster/post.js';
import {
  getLastReviewedSha,
  setLastReviewedSha,
  getPostedFingerprints,
  recordPostedFingerprints,
} from '../state/reviews.js';
import { installationOctokit, installationToken, patOctokit } from '../github/app.js';

const log = buildLogger(process.env['OPEN_REVIEW_LOG_LEVEL'] ?? 'info');

/**
 * Run a full review for the given job payload.
 *
 * Throws on missing GitHub auth or runner errors so the queue can handle them.
 * postReview is wrapped in log-and-drop (in post.ts) so posting failures never
 * disturb the SC5 worktree cleanup guarantee.
 */
export async function runReview(job: JobPayload, config: ConfigStore): Promise<JobResult> {
  const provider = getProvider();

  // Step 1: Resolve GitHub auth.
  let githubToken: string;
  let octokit: ReturnType<typeof installationOctokit> | undefined;

  if (
    config.githubAppId &&
    config.githubAppPrivateKey &&
    job.installationId !== undefined
  ) {
    const creds = { appId: config.githubAppId, privateKey: config.githubAppPrivateKey };
    githubToken = await installationToken(creds, job.installationId);
    octokit = installationOctokit(creds, job.installationId);
  } else {
    const pat = config.githubToken ?? process.env['GITHUB_TOKEN'];
    if (!pat) {
      throw new Error(
        'No GitHub auth available: set GITHUB_APP_ID + GITHUB_APP_PRIVATE_KEY (App mode) or GITHUB_TOKEN (PAT mode)',
      );
    }
    githubToken = pat;
    octokit = patOctokit(pat);
  }

  const { wtDir, bareDir } = await acquireWorktree(
    job.owner,
    job.repo,
    job.headSha,
    githubToken,
  );

  try {
    const prId = `${job.owner}/${job.repo}#${job.prNumber}`;

    // Step 3: Incremental vs full review (INCR-01).
    const lastSha = getLastReviewedSha(prId);
    const incremental =
      lastSha !== null && (await isAncestor(bareDir, lastSha, job.headSha));
    const diffBase = incremental ? (lastSha as string) : job.baseSha;

    const diff = await getDiff(bareDir, diffBase, job.headSha, config.ignoreGlobs);
    const guidelines = await readProjectGuidelines(wtDir);

    const prompt = buildPrompt(diff, job, wtDir, {
      incremental,
      ...(guidelines ? { guidelines } : {}),
    });

    const out = await provider.invoke(prompt, wtDir);
    const parsed = provider.parseOutput(out);

    // Step 8: Fingerprint dedup + min-severity filter.
    const seen = getPostedFingerprints(prId);
    const freshFindings = parsed.findings
      .filter((f) => !seen.has(fingerprintFinding(f)))
      .filter((f) => meetsMinSeverity(f.severity, config.minSeverity));

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
      ignoreGlobs: config.ignoreGlobs,
    });

    // Step 10: Record state after successful review+post.
    recordPostedFingerprints(prId, freshFindings.map(fingerprintFinding));
    setLastReviewedSha(prId, job.headSha);

    return { findings: freshFindings, summary: parsed.summary };
  } finally {
    // SC5: cleanup runs on every exit path.
    await releaseWorktree(wtDir, bareDir).catch((err: unknown) => {
      log.error({ err: scrub(String(err)) }, 'worktree cleanup failed -- orphan may exist');
    });
  }
}
