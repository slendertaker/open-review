/**
 * Shared canonical finding types and parsing logic (D-03, D-04).
 *
 * Handles three output shapes without throwing (SC4 robustness):
 *   (a) subtype === 'success' with structured_output -> validated findings array
 *   (b) subtype === 'error_max_structured_output_retries' -> parse result text
 *   (c) garbled non-JSON stdout -> parse raw text
 *
 * Pure module -- no I/O, no logging.
 */

import { createHash } from 'node:crypto';

export interface Finding {
  file: string;
  line: number;
  severity: 'critical' | 'high' | 'medium' | 'low';
  message: string;
  /** Short headline (10 words or less) used as the bold title in the rendered comment. */
  title?: string;
  /** Category label (e.g. security, performance). */
  category?: string;
  /** Concrete code fix, rendered in a collapsible "Suggested fix" block. */
  suggestion?: string;
}

export type Severity = Finding['severity'];

/** Severity ordering for threshold comparisons (low < medium < high < critical). */
export const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** True if `severity` is at least `min` on the rank scale. */
export function meetsMinSeverity(severity: Severity, min: Severity): boolean {
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[min];
}

/**
 * Stable fingerprint of a finding for cross-push dedup.
 *
 * Keyed on file + a normalized message (lowercased, alphanumeric-collapsed) --
 * NOT line or severity, which drift as a PR evolves or as Claude re-phrases.
 */
export function fingerprintFinding(f: Finding): string {
  const normMsg = f.message.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return createHash('sha1').update(`${f.file}\n${normMsg}`).digest('hex');
}

export interface ParsedOutput {
  findings: Finding[];
  summary: string;
}

/**
 * JSON schema string passed to --json-schema flag (D-07).
 * Items require exactly file/line/severity/message -- no optional fields forced here.
 */
export const FINDINGS_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: { type: 'string' },
          title: { type: 'string' },
          message: { type: 'string' },
          suggestion: { type: 'string' },
        },
        required: ['file', 'line', 'severity', 'message'],
      },
    },
    summary: { type: 'string' },
  },
  required: ['findings', 'summary'],
});

const SEVERITY_ENUM = new Set<string>(['critical', 'high', 'medium', 'low']);

/**
 * Validate and filter a raw array from structured_output into Finding[].
 * Never throws -- invalid items are silently dropped (SC4 robustness).
 */
function validateFindings(raw: unknown): Finding[] {
  if (!Array.isArray(raw)) return [];
  const results: Finding[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const file = r['file'];
    const lineRaw = r['line'];
    const severity = r['severity'];
    const message = r['message'];
    if (typeof file !== 'string') continue;
    if (typeof message !== 'string') continue;
    if (typeof severity !== 'string' || !SEVERITY_ENUM.has(severity)) continue;
    // GitHub inline comments require line >= 1.
    const line = Number(lineRaw);
    if (!Number.isInteger(line) || line < 1) continue;
    const title = r['title'];
    const category = r['category'];
    const suggestion = r['suggestion'];
    results.push({
      file,
      line,
      severity: severity as Finding['severity'],
      message,
      ...(typeof title === 'string' && title.trim() ? { title } : {}),
      ...(typeof category === 'string' && category.trim() ? { category } : {}),
      ...(typeof suggestion === 'string' && suggestion.trim() ? { suggestion } : {}),
    });
  }
  return results;
}

/**
 * Line-anchored regex scanning for finding lines of the form:
 *   <file>:<line>: [<severity>] <message>
 * Non-backtracking per line.
 */
const FINDING_LINE_RE = /^(.+?):(\d+):\s*\[(critical|high|medium|low)\]\s*(.+)$/gim;

/**
 * Parse finding objects from unstructured text (fallback for SC4 paths).
 * Returns empty array if no lines match -- never throws.
 */
function parseFindingsFromText(text: string): Finding[] {
  const findings: Finding[] = [];
  FINDING_LINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FINDING_LINE_RE.exec(text)) !== null) {
    const file = match[1]!.trim();
    const line = Number(match[2]);
    if (!file || !Number.isInteger(line) || line < 1) continue;
    findings.push({
      file,
      line,
      severity: match[3] as Finding['severity'],
      message: match[4]!.trim(),
    });
  }
  return findings;
}

/**
 * Extract a summary string from text.
 * Looks for a "Summary:" marker; otherwise returns the first non-empty line.
 */
function extractSummary(text: string): string {
  const summaryMarker = /Summary:\s*(.+)/i.exec(text);
  if (summaryMarker) return summaryMarker[1]!.trim();
  const firstLine = text.split('\n').find((l) => l.trim().length > 0);
  return firstLine?.trim() ?? '';
}

/**
 * Parse claude -p stdout into a typed ParsedOutput.
 * Never throws regardless of input shape (SC4).
 */
export function parseClaudeOutput(stdout: string, _stderr: string): ParsedOutput {
  let parsed: Record<string, unknown>;
  try {
    const raw = JSON.parse(stdout);
    // Guard: null, arrays, and primitives are not the expected object shape.
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { findings: parseFindingsFromText(stdout), summary: extractSummary(stdout) };
    }
    parsed = raw as Record<string, unknown>;
  } catch {
    return { findings: parseFindingsFromText(stdout), summary: extractSummary(stdout) };
  }

  // out.exitCode in the pipeline is the AUTHORITATIVE failure signal (T-jr6-01).
  // A 401 auth failure returns subtype 'success' with is_error:true / api_error_status:401
  // but EMPTY structured_output -- so it never reaches the branch below and falls through
  // to the empty-text fallback instead. That is exactly why pipeline.ts must gate on
  // exitCode (via assertProviderSucceeded) and NOT on parsed output.
  const so = parsed['structured_output'];
  if (parsed['subtype'] === 'success' && so !== null && typeof so === 'object') {
    const output = so as Record<string, unknown>;
    return {
      findings: validateFindings(output['findings']),
      summary: String(output['summary'] ?? ''),
    };
  }

  // Covers error_max_structured_output_retries and any unexpected subtype.
  const text = String(parsed['result'] ?? stdout);
  return { findings: parseFindingsFromText(text), summary: extractSummary(text) };
}
