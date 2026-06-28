/**
 * Git bare-clone cache + worktree lifecycle (D-11, T-01-T1, T-01-T2).
 *
 * - acquireWorktree: clones (first time) or fetches (reuse) a bare clone per repo,
 *   adds a fresh git worktree at the PR head SHA.
 * - releaseWorktree: removes the worktree with --force (ENGN-03 -- always in finally).
 * - getDiff: returns git diff base...head for the hybrid prompt.
 * - readProjectGuidelines: symlink-safe read of CLAUDE.md / AGENTS.md (D-15).
 * - pruneOrphanedWorktrees: startup crash-recovery.
 *
 * Security hardening:
 *   T-01-T1: execFile (no shell), NAME_RE/SHA_RE validation before any git call.
 *   T-01-T2: core.hooksPath=/dev/null on every clone to disable repo hooks.
 *   D-10: PAT in clone URL is never logged (scrub() before any log call).
 */

import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, lstat, realpath } from 'node:fs/promises';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import { buildLogger, scrub } from '../logger.js';

const execFile = promisify(execFileCb);

// CR-01: Boundary validation for webhook-derived fields.
const SHA_RE = /^[0-9a-f]{7,40}$/;
const NAME_RE = /^[A-Za-z0-9._-]+$/;

function assertSafe(value: string, re: RegExp, label: string): void {
  if (!re.test(value)) {
    throw new Error(`unsafe ${label}: ${JSON.stringify(value)}`);
  }
}

export const log = buildLogger(process.env['OPEN_REVIEW_LOG_LEVEL'] ?? 'info');

/** Bare-clone cache directory. Override with OPEN_REVIEW_CACHE_DIR for tests / alternate layouts. */
export const REPO_CACHE_DIR =
  process.env['OPEN_REVIEW_CACHE_DIR'] ??
  path.join(os.homedir(), '.open-review', 'repos');

/**
 * Acquire a fresh git worktree at `sha` for the given repo (D-11, ENGN-02).
 *
 * - First call: bare-clones with core.hooksPath=/dev/null (T-01-T2).
 * - Subsequent calls: re-injects auth and fetches.
 * - SHA recovery: targeted fetch if shallow clone missed the exact SHA.
 */
export async function acquireWorktree(
  owner: string,
  repo: string,
  sha: string,
  token: string,
): Promise<{ wtDir: string; bareDir: string }> {
  assertSafe(owner, NAME_RE, 'owner');
  assertSafe(repo, NAME_RE, 'repo');
  assertSafe(sha, SHA_RE, 'sha');

  const bareDir = path.join(REPO_CACHE_DIR, owner, `${repo}.git`);
  await mkdir(path.dirname(bareDir), { recursive: true });

  const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  if (!existsSync(bareDir)) {
    log.debug({ cmd: scrub(`git clone --bare ${cloneUrl} ${bareDir}`) }, 'bare clone');
    const { stderr } = await execFile('git', [
      'clone', '--bare', '--depth', '50',
      '--config', 'core.hooksPath=/dev/null',
      cloneUrl, bareDir,
    ]);
    if (stderr) log.debug({ stderr: scrub(stderr) }, 'git clone stderr');
  } else {
    log.debug({ cmd: scrub(`git -C ${bareDir} remote set-url origin ${cloneUrl}`) }, 'set-url');
    await execFile('git', ['-C', bareDir, 'remote', 'set-url', 'origin', cloneUrl]);

    log.debug({ cmd: scrub(`git -C ${bareDir} fetch --prune --depth 50 origin`) }, 'fetch');
    const { stderr } = await execFile('git', [
      '-C', bareDir, 'fetch', '--prune', '--depth', '50', 'origin',
    ]);
    if (stderr) log.debug({ stderr: scrub(stderr) }, 'git fetch stderr');
  }

  // Targeted SHA fetch fallback: shallow clones may miss the exact commit.
  const shaPresent = await execFile('git', ['-C', bareDir, 'cat-file', '-e', `${sha}^{commit}`])
    .then(() => true)
    .catch(() => false);
  if (!shaPresent) {
    log.debug({ cmd: scrub(`git -C ${bareDir} fetch --depth 50 origin ${sha}`) }, 'targeted sha fetch');
    const { stderr } = await execFile('git', ['-C', bareDir, 'fetch', '--depth', '50', 'origin', sha]);
    if (stderr) log.debug({ stderr: scrub(stderr) }, 'targeted fetch stderr');
  }

  const sha8 = sha.slice(0, 8);
  const wtDir = path.join(os.tmpdir(), `or-${owner}-${repo}-${sha8}-${Date.now()}`);
  log.debug({ cmd: scrub(`git -C ${bareDir} worktree add --detach ${wtDir} ${sha}`) }, 'worktree add');
  const { stderr: wtStderr } = await execFile('git', [
    '-C', bareDir, 'worktree', 'add', '--detach', wtDir, sha,
  ]);
  if (wtStderr) log.debug({ stderr: scrub(wtStderr) }, 'worktree add stderr');

  return { wtDir, bareDir };
}

/**
 * Remove a worktree created by acquireWorktree (ENGN-03 -- called in finally).
 * Uses --force to ensure cleanup succeeds even if the worktree appears "dirty".
 * Errors are swallowed by the caller so they never mask the original error.
 */
export async function releaseWorktree(wtDir: string, bareDir: string): Promise<void> {
  log.debug(
    { cmd: scrub(`git -C ${bareDir} worktree remove --force ${wtDir}`) },
    'worktree remove',
  );
  const { stderr } = await execFile('git', [
    '-C', bareDir, 'worktree', 'remove', '--force', wtDir,
  ]);
  if (stderr) log.debug({ stderr: scrub(stderr) }, 'worktree remove stderr');
}

/** Convention files to surface to the reviewer (priority order). */
const GUIDELINE_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  '.github/copilot-instructions.md',
  '.cursorrules',
] as const;

const GUIDELINES_CAP = 8000;

export interface ProjectGuidelines {
  file: string;
  content: string;
}

/**
 * Read the reviewed repo's first available convention file from the worktree.
 *
 * Security (D-15 / symlink traversal): lstat to reject symlinks, then realpath
 * to ensure the file is inside the worktree directory before reading.
 */
export async function readProjectGuidelines(wtDir: string): Promise<ProjectGuidelines | null> {
  let realWt: string;
  try {
    realWt = await realpath(wtDir);
  } catch {
    return null;
  }
  for (const name of GUIDELINE_FILES) {
    const filePath = path.join(wtDir, name);
    try {
      const st = await lstat(filePath);
      if (!st.isFile()) continue;
      const real = await realpath(filePath);
      if (real !== realWt && !real.startsWith(realWt + path.sep)) continue;
      let content = await readFile(filePath, 'utf8');
      if (!content.trim()) continue;
      if (content.length > GUIDELINES_CAP) {
        content = content.slice(0, GUIDELINES_CAP) + '\n\n[truncated -- convention file exceeds cap]';
      }
      return { file: name, content };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Return true if `ancestor` is an ancestor of `head` in the bare clone.
 * Used for incremental review decision (INCR-01).
 */
export async function isAncestor(
  bareDir: string,
  ancestor: string,
  head: string,
): Promise<boolean> {
  assertSafe(ancestor, SHA_RE, 'ancestor');
  assertSafe(head, SHA_RE, 'head');
  if (ancestor === head) return false;
  return execFile('git', ['-C', bareDir, 'merge-base', '--is-ancestor', ancestor, head])
    .then(() => true)
    .catch(() => false);
}

/**
 * Return the inline diff between baseSha and headSha (three-dot range).
 * Excludes ignore globs; caps at 500 KB; never throws.
 */
export async function getDiff(
  bareDir: string,
  baseSha: string,
  headSha: string,
  ignoreGlobs: string[],
): Promise<string> {
  assertSafe(baseSha, SHA_RE, 'baseSha');
  assertSafe(headSha, SHA_RE, 'headSha');

  // Fetch base SHA if missing from shallow clone.
  const basePresent = await execFile('git', [
    '-C', bareDir, 'cat-file', '-e', `${baseSha}^{commit}`,
  ])
    .then(() => true)
    .catch(() => false);
  if (!basePresent) {
    await execFile('git', ['-C', bareDir, 'fetch', '--depth', '50', 'origin', baseSha]);
  }

  const excludeArgs = ignoreGlobs.map((g) => `:(exclude)${g}`);
  log.debug({ cmd: scrub(`git -C ${bareDir} diff ${baseSha}...${headSha}`) }, 'git diff');

  const { stdout } = await execFile(
    'git',
    ['-C', bareDir, 'diff', `${baseSha}...${headSha}`, '--', '.', ...excludeArgs],
    { maxBuffer: 10 * 1024 * 1024 },
  );

  const DIFF_CAP = 500 * 1024;
  if (stdout.length > DIFF_CAP) {
    let cut = stdout.lastIndexOf('\n', DIFF_CAP);
    if (cut < 0) cut = DIFF_CAP;
    log.info({ originalBytes: stdout.length, cap: DIFF_CAP }, 'diff truncated at 500 KB cap');
    return stdout.slice(0, cut) + '\n\n[diff truncated: exceeded 500 KB cap]\n';
  }
  return stdout;
}

/**
 * Startup crash-recovery: prune stale worktree refs in all bare clones.
 * Per-repo errors are caught and logged so a single corrupt clone cannot block boot.
 */
export async function pruneOrphanedWorktrees(): Promise<void> {
  let owners: string[];
  try {
    owners = await readdir(REPO_CACHE_DIR);
  } catch {
    return;
  }

  for (const owner of owners) {
    const ownerDir = path.join(REPO_CACHE_DIR, owner);
    let repos: string[];
    try {
      repos = await readdir(ownerDir);
    } catch {
      continue;
    }

    for (const repoEntry of repos) {
      if (!repoEntry.endsWith('.git')) continue;
      const bareDir = path.join(ownerDir, repoEntry);
      await execFile('git', ['-C', bareDir, 'worktree', 'prune']).catch((err: Error) => {
        log.debug({ bareDir, err: err.message }, 'worktree prune failed (ignored)');
      });
    }
  }
}
