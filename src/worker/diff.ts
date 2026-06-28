/**
 * Diff position mapping (POST-02, NOISE-05).
 *
 * buildDiffMap parses a unified diff and returns a Map of:
 *   filename -> Set of RIGHT-side (new file) line numbers
 *
 * Only added (type='add') and context (type='normal') lines are included.
 * Deleted lines (type='del') are excluded -- they have no right-side position.
 *
 * isPostable checks whether a finding's (file, line) tuple is in the diff map,
 * which determines if GitHub can accept an inline comment at that position.
 */

import parseDiff from 'parse-diff';

/**
 * Parse a unified diff string and build a map of file -> right-side line numbers.
 *
 * Uses parse-diff to handle the hunk header math correctly.
 * Never throws -- returns an empty Map on any parse error.
 */
export function buildDiffMap(diffText: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  if (!diffText || !diffText.trim()) return result;

  let files: ReturnType<typeof parseDiff>;
  try {
    files = parseDiff(diffText);
  } catch {
    return result;
  }

  for (const file of files) {
    // Skip /dev/null (deleted file header) and empty file paths.
    const filePath = file.to ?? file.from;
    if (!filePath || filePath === '/dev/null') continue;

    // Strip the a/ and b/ prefixes that git diff adds.
    const normalizedPath = filePath.replace(/^[ab]\//, '');

    const lines = new Set<number>();

    for (const chunk of file.chunks) {
      for (const change of chunk.changes) {
        if (change.type === 'add') {
          // change.ln is the right-side (new file) line number for added lines.
          if (change.ln > 0) lines.add(change.ln);
        } else if (change.type === 'normal') {
          // change.ln2 is the right-side line number for context lines.
          if (change.ln2 > 0) lines.add(change.ln2);
        }
        // 'del' lines have no right-side position -- excluded.
      }
    }

    result.set(normalizedPath, lines);
  }

  return result;
}

/**
 * Return true if a finding at (filePath, line) can be posted as an inline comment.
 *
 * A finding is postable only if both the file and the exact line appear in the
 * diff map. Off-diff findings are routed to the summary body instead.
 */
export function isPostable(
  diffMap: Map<string, Set<number>>,
  filePath: string,
  line: number,
): boolean {
  const lines = diffMap.get(filePath);
  if (!lines) return false;
  return lines.has(line);
}
