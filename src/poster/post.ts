/**
 * PR review poster (POST-01..03, POST-04, POST-05, NOISE-04).
 *
 * Submits a single batched createReview call with severity-labeled inline
 * comments and an assembled summary body. Out-of-diff findings are routed
 * to the summary body. Findings on ignored files are dropped entirely.
 * Inline comments capped at 50; overflow routed to summary (POST-04).
 * 422 from GitHub falls back to summary-only retry (POST-05).
 *
 * No em-dashes in user-facing strings (project style rule).
 */

import picomatch from 'picomatch';
import type { Finding } from '../provider/parser.js';
import type { Octokit } from '@octokit/rest';
import { isPostable } from '../worker/diff.js';
import { buildLogger, scrub } from '../logger.js';

// picomatch v4 is CJS -- default-import then destructure.
const { isMatch } = picomatch;

export const log = buildLogger(process.env['OPEN_REVIEW_LOG_LEVEL'] ?? 'info');

/**
 * Default set of path globs to exclude from the diff before review.
 * Re-exported so tests can compare against it directly.
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

/** GitHub caps inline comments per createReview request. */
const MAX_INLINE_COMMENTS = 50;

/** Severity count rollup shape. */
export interface SeverityCounts {
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/**
 * Return true if the finding's file matches any of the ignore globs.
 * Uses picomatch with { dot: true } for dotfile matching.
 */
export function isIgnored(filePath: string, globs: string[]): boolean {
  if (globs.length === 0) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return globs.some((g) => isMatch(normalized, g, { dot: true }));
}

/** Severity badge (one per finding -- no bracket labels). */
const SEVERITY_BADGE: Record<Finding['severity'], string> = {
  critical: '[CRITICAL]',
  high: '[HIGH]',
  medium: '[MEDIUM]',
  low: '[LOW]',
};

function headlineOf(f: Finding): string {
  return (f.title?.trim() || f.message.trim()).replace(/\s+/g, ' ');
}

/**
 * Render one inline review comment.
 * No em-dashes in output (project style rule).
 */
export function renderInlineComment(f: Finding): string {
  const badge = SEVERITY_BADGE[f.severity];
  const blocks: string[] = [`${badge} **${headlineOf(f)}**`];

  const message = f.message?.trim();
  if (message && f.title?.trim() && message !== f.title.trim()) {
    blocks.push(message);
  }

  const fix = f.suggestion?.trim();
  if (fix) {
    blocks.push(
      ['<details>', '<summary>Suggested fix</summary>', '', '```', fix, '```', '', '</details>'].join('\n'),
    );
  }

  return blocks.join('\n\n');
}

/**
 * Assemble the review summary body.
 * No em-dashes in output (project style rule).
 */
export function buildSummaryBody(
  claudeSummary: string,
  counts: SeverityCounts,
  offDiff: Finding[],
): string {
  const total = counts.critical + counts.high + counts.medium + counts.low;

  let alert: string;
  if (counts.critical > 0) {
    alert = `> [!CAUTION]\n> ${counts.critical} blocking issue(s) found -- please resolve before merging.`;
  } else if (counts.high > 0) {
    alert = `> [!IMPORTANT]\n> ${counts.high} issue(s) to address before merging.`;
  } else if (total > 0) {
    alert = '> [!NOTE]\n> Minor suggestions only -- mergeable as-is.';
  } else {
    alert = '> No issues found -- looks good to merge.';
  }

  const blocks: string[] = [alert];

  const prose = claudeSummary?.trim();
  if (prose) blocks.push(prose);

  if (total > 0) {
    blocks.push(
      `[CRITICAL] **${counts.critical}** / [HIGH] **${counts.high}** / [MEDIUM] **${counts.medium}** / [LOW] **${counts.low}** (${total} finding(s))`,
    );
  }

  if (offDiff.length > 0) {
    const items = offDiff
      .map((f) => {
        const head = f.title?.trim();
        const body = f.message?.trim() ?? '';
        const text = head ? `**${head}** - ${body}` : body;
        return `- ${SEVERITY_BADGE[f.severity]} \`${f.file}:${f.line}\` ${text}`.trimEnd();
      })
      .join('\n');
    blocks.push(
      [
        '<details>',
        `<summary>Additional findings outside the diff (${offDiff.length})</summary>`,
        '',
        items,
        '',
        '</details>',
      ].join('\n'),
    );
  }

  return blocks.join('\n\n');
}

/**
 * Partition findings into inline (postable, capped at 50) and off-diff lists
 * after dropping any finding whose file matches an ignore glob (NOISE-04).
 *
 * Returns { inline, offDiff, counts } where inline is capped at MAX_INLINE_COMMENTS
 * and overflow is appended to offDiff.
 */
export function partitionFindings(
  findings: Finding[],
  diffMap: Map<string, Set<number>>,
  ignoreGlobs: string[],
): { inline: Finding[]; offDiff: Finding[]; counts: SeverityCounts } {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  const inlineAll: Finding[] = [];
  const offDiff: Finding[] = [];

  for (const finding of findings) {
    if (isIgnored(finding.file, ignoreGlobs)) continue;

    counts[finding.severity]++;

    if (isPostable(diffMap, finding.file, finding.line)) {
      inlineAll.push(finding);
    } else {
      offDiff.push(finding);
    }
  }

  // Cap inline at 50; route overflow to off-diff (POST-04).
  const inline = inlineAll.slice(0, MAX_INLINE_COMMENTS);
  const overflow = inlineAll.slice(MAX_INLINE_COMMENTS);
  offDiff.push(...overflow);

  return { inline, offDiff, counts };
}

/** Arguments for postReview. */
export interface PostReviewArgs {
  /** Injected Octokit instance (required -- callers must supply it). */
  octokit: Pick<Octokit, 'rest'>;
  owner: string;
  repo: string;
  pullNumber: number;
  commitId: string;
  findings: Finding[];
  summary: string;
  diffMap: Map<string, Set<number>>;
  ignoreGlobs: string[];
}

/**
 * Post a single batched PR review (POST-01, POST-02, POST-03).
 *
 * Builds inline comments for postable findings and routes the rest to the
 * summary body. Makes one octokit.rest.pulls.createReview call with event:'COMMENT'.
 * If that call fails (e.g. 422 from a bad inline comment), retries with summary-only (POST-05).
 * Never throws -- posting failure is logged-and-dropped so SC5 cleanup is not disturbed.
 */
export async function postReview(args: PostReviewArgs): Promise<void> {
  const { octokit, owner, repo, pullNumber, commitId, findings, summary, diffMap, ignoreGlobs } =
    args;

  const { inline, offDiff, counts } = partitionFindings(findings, diffMap, ignoreGlobs);

  // Belt-and-suspenders re-validation before calling GitHub (WR-02).
  const validInline = inline.filter(
    (f) => f.file && Number.isInteger(f.line) && f.line >= 1 && isPostable(diffMap, f.file, f.line),
  );

  const comments = validInline.map((f) => ({
    path: f.file,
    line: f.line,
    side: 'RIGHT' as const,
    body: renderInlineComment(f),
  }));

  const allOffDiff = [...offDiff, ...inline.filter((f) => !validInline.includes(f))];
  const body = buildSummaryBody(summary, counts, allOffDiff);

  try {
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      commit_id: commitId,
      event: 'COMMENT',
      body,
      comments,
    });
    log.info({ owner, repo, pullNumber, commentCount: comments.length }, 'review posted');
  } catch (err: unknown) {
    log.error({ err: scrub(String(err)) }, 'createReview failed -- retrying summary only');

    // POST-05: 422 fallback -- retry without inline comments.
    if (comments.length > 0) {
      try {
        await octokit.rest.pulls.createReview({
          owner,
          repo,
          pull_number: pullNumber,
          commit_id: commitId,
          event: 'COMMENT',
          body,
          // No comments field in fallback call.
        });
        log.info({ owner, repo, pullNumber, commentCount: 0 }, 'review posted (summary-only fallback)');
        return;
      } catch (fallbackErr: unknown) {
        log.error(
          { err: scrub(String(fallbackErr)) },
          'summary-only fallback failed -- review not posted',
        );
      }
    }
    // Log-and-drop: do not rethrow.
  }
}
