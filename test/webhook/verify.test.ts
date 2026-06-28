/**
 * Wave 0 test: HMAC-SHA256 webhook signature verification
 * Requirement: INTK-01
 *
 * Tests the verifySignature function from src/webhook/verify.ts.
 * All imports use .js extension per NodeNext ESM resolution.
 */

import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { verifySignature } from '../../src/webhook/verify.js';

const SECRET = 'test-webhook-secret-123';
const BODY = Buffer.from(JSON.stringify({ action: 'opened', pull_request: { id: 42 } }));

function makeSignature(body: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

describe('verifySignature (INTK-01)', () => {
  it('returns true for a valid HMAC-SHA256 signature', () => {
    const sig = makeSignature(BODY, SECRET);
    expect(verifySignature(BODY, sig, SECRET)).toBe(true);
  });

  it('returns false for a tampered body', () => {
    const sig = makeSignature(BODY, SECRET);
    const tamperedBody = Buffer.from(JSON.stringify({ action: 'closed' }));
    expect(verifySignature(tamperedBody, sig, SECRET)).toBe(false);
  });

  it('returns false for a tampered signature', () => {
    const wrongSig = makeSignature(Buffer.from('wrong'), SECRET);
    expect(verifySignature(BODY, wrongSig, SECRET)).toBe(false);
  });

  it('returns false when the signature header is missing (undefined)', () => {
    expect(verifySignature(BODY, undefined, SECRET)).toBe(false);
  });

  it('returns false when the signature header is an empty string', () => {
    expect(verifySignature(BODY, '', SECRET)).toBe(false);
  });

  it('returns false when the header lacks the sha256= prefix', () => {
    const rawHex = createHmac('sha256', SECRET).update(BODY).digest('hex');
    expect(verifySignature(BODY, rawHex, SECRET)).toBe(false);
  });

  it('returns false when the header has the wrong length (prevents timingSafeEqual throw)', () => {
    expect(verifySignature(BODY, 'sha256=tooshort', SECRET)).toBe(false);
  });

  it('never throws on any input (robustness)', () => {
    expect(() => verifySignature(Buffer.from(''), undefined, '')).not.toThrow();
    expect(() => verifySignature(Buffer.from(''), 'sha256=', '')).not.toThrow();
  });
});
