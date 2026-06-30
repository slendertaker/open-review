/**
 * Logger redaction tests (Phase 5 Wave 0 RED).
 *
 * Pins the log-redaction extension requirement (D5-08, SC-4):
 *   - PEM private key blocks must be redacted from free-form log strings
 *   - GitHub App client secrets must be redacted from free-form log strings
 *
 * These tests MUST fail now (RED) because SCRUB_RE does not yet include
 * PEM-block or client-secret patterns. They turn green after Plan 02 extends
 * src/logger.ts with the Pattern 6 SCRUB_RE additions.
 *
 * Import: uses .js extension per NodeNext ESM resolution.
 */

import { describe, it, expect } from 'vitest';
import { scrub } from '../src/logger.js';

// ---------------------------------------------------------------------------
// Test fixtures -- synthetic, non-functional strings only (T-05-01 accepted risk)
// ---------------------------------------------------------------------------

// A multi-line RSA private key PEM block (not a real key -- for redaction testing only)
const SAMPLE_RSA_PEM = [
  '-----BEGIN RSA PRIVATE KEY-----',
  'MIIEowIBAAKCAQEA0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN',
  'OPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQR',
  'STUVWXYZabcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  '-----END RSA PRIVATE KEY-----',
].join('\n');

// A PKCS#8 format PEM block (GitHub also uses this format)
const SAMPLE_PKCS8_PEM = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC0123456789abcd',
  '-----END PRIVATE KEY-----',
].join('\n');

// A synthetic GitHub App client secret (40 hex chars is within reasonable range)
const SAMPLE_CLIENT_SECRET = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

// ---------------------------------------------------------------------------
// Log redaction tests (D5-08, SC-4)
// ---------------------------------------------------------------------------

/**
 * D5-08: PEM private key blocks in log strings must be replaced with [REDACTED].
 * The SCRUB_RE in src/logger.ts must be extended to match:
 *   /-----BEGIN[A-Z ]+PRIVATE KEY-----[\s\S]+?-----END[A-Z ]+PRIVATE KEY-----/gi
 */
describe('log redaction (D5-08, SC-4)', () => {
  it('scrub() redacts RSA PRIVATE KEY PEM block from a log string', () => {
    // RED: SCRUB_RE does not yet match PEM blocks -- scrub() returns unchanged string
    const logMessage = `GitHub callback: persisting credentials pem=${SAMPLE_RSA_PEM} slug=open-review-abc`;
    const result = scrub(logMessage);
    // The PEM body content must not appear in the output
    expect(result).not.toContain('MIIEowIBAAKCAQEA');
    expect(result).not.toContain('OPQRSTUVWXYZ0123456789');
    // Should contain the redaction marker
    expect(result).toContain('[REDACTED]');
  });

  it('scrub() redacts PKCS#8 PRIVATE KEY PEM block from a log string', () => {
    // RED: SCRUB_RE does not yet match PKCS#8 PEM blocks
    const logMessage = `Private key received: ${SAMPLE_PKCS8_PEM}`;
    const result = scrub(logMessage);
    // The PEM body must not appear
    expect(result).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC0123456789abcd');
    expect(result).toContain('[REDACTED]');
  });

  it('scrub() removes the PEM begin/end markers along with the body', () => {
    // The entire block (markers + body) should be replaced, not just the body
    // RED: no PEM pattern in SCRUB_RE today
    const result = scrub(`key: ${SAMPLE_RSA_PEM} end`);
    // Neither the begin nor end marker should survive in the output
    expect(result).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(result).not.toContain('END RSA PRIVATE KEY');
    expect(result).toContain('[REDACTED]');
  });

  it('scrub() redacts a GitHub App client secret from a log string', () => {
    // RED: SCRUB_RE does not yet specifically match client secrets by pattern
    // Note: this fixture is a 40-char hex string, which may or may not match
    // existing token= pattern. The test asserts the secret value is not leaked.
    // If it already matches via token= pattern, the test still passes.
    const logMessage = `client_secret=${SAMPLE_CLIENT_SECRET} stored`;
    const result = scrub(logMessage);
    // The raw secret value must not appear in the scrubbed output
    expect(result).not.toContain(SAMPLE_CLIENT_SECRET);
  });

  it('scrub() does not modify strings with no sensitive content', () => {
    const safe = 'GitHub App connected: slug=open-review-abc123, app_id=123456';
    const result = scrub(safe);
    // Non-sensitive strings must pass through unchanged
    expect(result).toBe(safe);
  });

  it('scrub() still redacts existing patterns (regression guard for SC-5)', () => {
    // Existing SCRUB_RE patterns must continue to work after the Phase 5 extension
    const withApiKey = 'key: sk-ant-api03-testkey-abcdefgh1234567890';
    const result = scrub(withApiKey);
    expect(result).not.toContain('sk-ant-api03-testkey-abcdefgh1234567890');
    expect(result).toContain('[REDACTED]');
  });
});
