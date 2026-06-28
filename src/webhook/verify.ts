/**
 * HMAC-SHA256 webhook signature verification (INTK-01, T-01-S1).
 *
 * Returns true only if the signature matches; false for any invalid/missing/mismatched case.
 * Never throws -- all error paths return false.
 * Uses a length guard before timingSafeEqual to prevent ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  try {
    const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
    const sigBuf = Buffer.from(signatureHeader);
    const expBuf = Buffer.from(expected);

    // Length guard: timingSafeEqual throws on length mismatch.
    if (sigBuf.length !== expBuf.length) {
      return false;
    }

    return timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}
