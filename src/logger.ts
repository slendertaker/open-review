/**
 * Structured logger with secret scrubbing (D-10, T-01-I3).
 *
 * pino is configured to:
 *   - Redact the Authorization header and x-hub-signature-256 header from
 *     serialized request/response objects (prevents accidental log injection).
 *   - Expose scrub() for callers to sanitize free-form strings (git output,
 *     subprocess stderr) before passing them to the logger.
 */

import pino from 'pino';

/**
 * Regex patterns for secret token prefixes to scrub from free-form strings.
 * Covers Claude/Anthropic API keys, AWS keys, and GitHub tokens.
 */
const SCRUB_RE =
  /(sk-ant-[A-Za-z0-9_-]+|AKIA[0-9A-Z]{16}|gh[ps]_[A-Za-z0-9]+|github_pat_[A-Za-z0-9_]+|x-access-token:[^\s@]+|Bearer [A-Za-z0-9._\-]+)/gi;

/**
 * Scrub secret token values from a free-form string.
 * Replaces matched tokens with [REDACTED] so logs never contain raw credentials.
 */
export function scrub(text: string): string {
  return text.replace(SCRUB_RE, '[REDACTED]');
}

/**
 * Create a pino logger with secret-redact paths for HTTP headers.
 *
 * The `redact` option applies to pino's serialized objects (req.headers.*).
 * Use `scrub()` separately for raw strings from subprocesses or git output.
 */
export function buildLogger(level: string = 'info'): pino.Logger {
  return pino({
    level,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["x-hub-signature-256"]',
        'req.headers["x-access-token"]',
      ],
      censor: '[REDACTED]',
    },
  });
}

// Module-level default logger for consumers that import directly.
export const log = buildLogger(process.env['OPEN_REVIEW_LOG_LEVEL'] ?? 'info');
