/**
 * Poster tests (50-cap, 422 fallback, ignore globs, buildSummaryBody, renderInlineComment)
 * Requirements: POST-03, POST-04, POST-05, NOISE-04
 *
 * Tests partitionFindings, postReview (mocked octokit), isIgnored,
 * buildSummaryBody, and renderInlineComment from src/poster/post.ts.
 * All imports use .js extension per NodeNext ESM resolution.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  partitionFindings,
  isIgnored,
  postReview,
  buildSummaryBody,
  renderInlineComment,
  DEFAULT_IGNORE_GLOBS,
} from '../../src/poster/post.js';

// Canonical Finding type (D-04)
interface Finding {
  file: string;
  line: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  title?: string;
  suggestion?: string;
}

/** Build a simple diffMap with a single file containing line numbers 1-200 */
function buildTestDiffMap(filePath: string, lines: number[]): Map<string, Set<number>> {
  return new Map([[filePath, new Set(lines)]]);
}

/** Build N findings all postable in the given diffMap file */
function buildFindings(count: number, filePath: string, startLine = 1): Finding[] {
  return Array.from({ length: count }, (_, i) => ({
    file: filePath,
    line: startLine + i,
    severity: 'medium' as const,
    message: `Finding number ${startLine + i}`,
  }));
}

describe('partitionFindings (POST-04)', () => {
  const FILE = 'src/auth.ts';
  // Build a diffMap covering lines 1-100
  const diffMap = buildTestDiffMap(FILE, Array.from({ length: 100 }, (_, i) => i + 1));

  it('partitions 51 findings: exactly 50 inline and 1 in offDiff / overflow', () => {
    const findings = buildFindings(51, FILE);
    const { inline, offDiff } = partitionFindings(findings, diffMap, []);
    // inline must be capped at 50 (POST-04)
    expect(inline).toHaveLength(50);
    // The 51st finding should be routed elsewhere (offDiff or overflow)
    const total = inline.length + offDiff.length;
    expect(total).toBe(51);
  });

  it('routes findings not in the diffMap to offDiff', () => {
    const inDiff = buildFindings(2, FILE, 1);
    const notInDiff: Finding[] = [
      { file: FILE, line: 999, severity: 'high', message: 'Off-diff finding' },
    ];
    const { inline, offDiff } = partitionFindings([...inDiff, ...notInDiff], diffMap, []);
    expect(inline).toHaveLength(2);
    expect(offDiff).toHaveLength(1);
  });

  it('drops findings whose file matches an ignore glob (NOISE-04)', () => {
    const lockFileFinding: Finding = {
      file: 'package-lock.json',
      line: 5,
      severity: 'low',
      message: 'Lockfile finding',
    };
    const lockDiffMap = buildTestDiffMap('package-lock.json', [5]);
    const { inline, offDiff } = partitionFindings([lockFileFinding], lockDiffMap, DEFAULT_IGNORE_GLOBS);
    expect(inline).toHaveLength(0);
    expect(offDiff).toHaveLength(0);
  });

  it('accumulates severity counts correctly', () => {
    const findings: Finding[] = [
      { file: FILE, line: 1, severity: 'critical', message: 'c1' },
      { file: FILE, line: 2, severity: 'high', message: 'h1' },
      { file: FILE, line: 3, severity: 'medium', message: 'm1' },
      { file: FILE, line: 4, severity: 'low', message: 'l1' },
    ];
    const { counts } = partitionFindings(findings, diffMap, []);
    expect(counts.critical).toBe(1);
    expect(counts.high).toBe(1);
    expect(counts.medium).toBe(1);
    expect(counts.low).toBe(1);
  });
});

describe('postReview - 422 fallback (POST-05)', () => {
  it('retries with summary-only body when createReview throws 422 with comments', async () => {
    const FILE = 'src/index.ts';
    const diffMap = buildTestDiffMap(FILE, [1, 2, 3]);
    const findings = buildFindings(3, FILE);

    // Mock octokit: first call (with comments) throws 422; second call (summary-only) succeeds
    const createReview = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Unprocessable Entity'), { status: 422 }))
      .mockResolvedValueOnce({ data: { id: 999 } });

    const mockOctokit = {
      rest: {
        pulls: { createReview },
      },
    };

    await expect(
      postReview({
        octokit: mockOctokit as unknown as Parameters<typeof postReview>[0]['octokit'],
        owner: 'owner',
        repo: 'repo',
        pullNumber: 1,
        commitId: 'abc123',
        findings,
        summary: 'Test summary',
        diffMap,
        ignoreGlobs: [],
      }),
    ).resolves.not.toThrow();

    // createReview should have been called twice (once with comments, once body-only)
    expect(createReview).toHaveBeenCalledTimes(2);

    // The second call must NOT include comments (summary-only fallback)
    const secondCall = createReview.mock.calls[1]![0] as { comments?: unknown };
    expect(secondCall.comments).toBeUndefined();
  });

  it('does not throw when all postable findings post successfully', async () => {
    const FILE = 'src/clean.ts';
    const diffMap = buildTestDiffMap(FILE, [1]);
    const findings = buildFindings(1, FILE);

    const createReview = vi.fn().mockResolvedValue({ data: { id: 1 } });
    const mockOctokit = { rest: { pulls: { createReview } } };

    await expect(
      postReview({
        octokit: mockOctokit as unknown as Parameters<typeof postReview>[0]['octokit'],
        owner: 'owner',
        repo: 'repo',
        pullNumber: 1,
        commitId: 'abc',
        findings,
        summary: 'Clean',
        diffMap,
        ignoreGlobs: [],
      }),
    ).resolves.not.toThrow();
  });
});

describe('isIgnored (NOISE-04)', () => {
  it('returns true for package-lock.json against DEFAULT_IGNORE_GLOBS', () => {
    expect(isIgnored('package-lock.json', DEFAULT_IGNORE_GLOBS)).toBe(true);
  });

  it('returns true for nested lockfile path', () => {
    expect(isIgnored('frontend/package-lock.json', DEFAULT_IGNORE_GLOBS)).toBe(true);
  });

  it('returns true for yarn.lock', () => {
    expect(isIgnored('yarn.lock', DEFAULT_IGNORE_GLOBS)).toBe(true);
  });

  it('returns false for a normal source file', () => {
    expect(isIgnored('src/index.ts', DEFAULT_IGNORE_GLOBS)).toBe(false);
  });

  it('returns false for an empty glob list', () => {
    expect(isIgnored('package-lock.json', [])).toBe(false);
  });

  it('returns true for minified JS files', () => {
    expect(isIgnored('dist/bundle.min.js', DEFAULT_IGNORE_GLOBS)).toBe(true);
  });
});

describe('buildSummaryBody (POST-03)', () => {
  const noFindings = { critical: 0, high: 0, medium: 0, low: 0 };

  it('emits [!CAUTION] alert when there are critical findings', () => {
    const body = buildSummaryBody('', { critical: 2, high: 0, medium: 0, low: 0 }, []);
    expect(body).toContain('[!CAUTION]');
  });

  it('emits [!IMPORTANT] alert when there are high (but no critical) findings', () => {
    const body = buildSummaryBody('', { critical: 0, high: 1, medium: 0, low: 0 }, []);
    expect(body).toContain('[!IMPORTANT]');
  });

  it('emits [!NOTE] alert when there are only medium/low findings', () => {
    const body = buildSummaryBody('', { critical: 0, high: 0, medium: 3, low: 1 }, []);
    expect(body).toContain('[!NOTE]');
  });

  it('emits a clean blockquote (no alert tier) when there are no findings', () => {
    const body = buildSummaryBody('', noFindings, []);
    // Should NOT include any alert tier
    expect(body).not.toContain('[!CAUTION]');
    expect(body).not.toContain('[!IMPORTANT]');
    expect(body).not.toContain('[!NOTE]');
  });

  it('includes the prose summary when provided', () => {
    const body = buildSummaryBody('Great changes overall.', noFindings, []);
    expect(body).toContain('Great changes overall.');
  });

  it('includes severity rollup when there are findings', () => {
    const body = buildSummaryBody('', { critical: 1, high: 2, medium: 3, low: 4 }, []);
    // Should include counts for all severity levels
    expect(body).toContain('1');
    expect(body).toContain('2');
    expect(body).toContain('3');
    expect(body).toContain('4');
  });

  it('omits rollup when there are no findings', () => {
    const body = buildSummaryBody('', noFindings, []);
    // Total is 0 -- no rollup line should appear
    expect(body).not.toContain('finding');
  });

  it('includes off-diff findings in a <details> section', () => {
    const offDiff: Finding[] = [
      { file: 'src/old.ts', line: 42, severity: 'medium', message: 'Old code smell', title: 'Smell' },
    ];
    const body = buildSummaryBody('', { critical: 0, high: 0, medium: 1, low: 0 }, offDiff);
    expect(body).toContain('<details>');
    expect(body).toContain('src/old.ts');
    expect(body).toContain('42');
  });

  it('omits off-diff <details> when offDiff is empty', () => {
    const body = buildSummaryBody('', { critical: 1, high: 0, medium: 0, low: 0 }, []);
    expect(body).not.toContain('<details>');
  });

  it('contains no em-dashes (U+2014) in any emitted text (project style rule)', () => {
    const body = buildSummaryBody(
      'Prose summary here.',
      { critical: 1, high: 2, medium: 3, low: 4 },
      [{ file: 'src/foo.ts', line: 1, severity: 'high', message: 'A problem', title: 'Issue' }],
    );
    // U+2014 is an em-dash -- must not appear in posted text
    expect(body).not.toContain('—');
  });
});

describe('renderInlineComment (POST-03)', () => {
  it('renders a severity badge and headline', () => {
    const f: Finding = { file: 'src/a.ts', line: 1, severity: 'critical', message: 'Danger here' };
    const rendered = renderInlineComment(f);
    expect(rendered).toContain('CRITICAL');
    expect(rendered).toContain('Danger here');
  });

  it('renders a collapsible suggestion block when a suggestion is present', () => {
    const f: Finding = {
      file: 'src/a.ts',
      line: 1,
      severity: 'high',
      message: 'Use const',
      suggestion: 'const x = 1;',
    };
    const rendered = renderInlineComment(f);
    expect(rendered).toContain('<details>');
    expect(rendered).toContain('const x = 1;');
  });

  it('omits the suggestion block when no suggestion is provided', () => {
    const f: Finding = { file: 'src/a.ts', line: 1, severity: 'low', message: 'Minor thing' };
    const rendered = renderInlineComment(f);
    expect(rendered).not.toContain('<details>');
  });

  it('does not duplicate title and message when they are the same', () => {
    const f: Finding = {
      file: 'src/a.ts',
      line: 1,
      severity: 'medium',
      message: 'Same text',
      title: 'Same text',
    };
    const rendered = renderInlineComment(f);
    // "Same text" should appear exactly once as the headline (badge + **headline**)
    const occurrences = (rendered.match(/Same text/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it('contains no em-dashes (U+2014) in any emitted text (project style rule)', () => {
    const f: Finding = {
      file: 'src/a.ts',
      line: 1,
      severity: 'high',
      message: 'Some message',
      title: 'Some title',
      suggestion: 'Some fix',
    };
    const rendered = renderInlineComment(f);
    expect(rendered).not.toContain('—');
  });
});
