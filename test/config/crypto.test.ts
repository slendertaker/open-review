/**
 * AES-256-GCM crypto module tests (DCFG-02).
 *
 * Tests encryptSecret/decryptSecret round-trip, wrong-key throw, record shape,
 * IV uniqueness, maskSecret format, and loadMachineKey length validation.
 */

import { describe, it, expect } from 'vitest';
import { encryptSecret, decryptSecret, maskSecret, loadMachineKey } from '../../src/config/crypto.js';

const TEST_KEY = Buffer.alloc(32, 0x01); // deterministic 32-byte test key

describe('encryptSecret / decryptSecret (DCFG-02)', () => {
  it('round-trip: decryptSecret returns the original plaintext', () => {
    const plain = 'sk-ant-api03-test-secret';
    const record = encryptSecret(plain, TEST_KEY);
    expect(decryptSecret(record, TEST_KEY)).toBe(plain);
  });

  it('wrong key throws (GCM authentication failure)', () => {
    const key2 = Buffer.alloc(32, 0x02);
    const record = encryptSecret('my-secret', TEST_KEY);
    expect(() => decryptSecret(record, key2)).toThrow();
  });

  it('record has form ivHex:tagHex:ciphertextB64 (three colon-separated parts)', () => {
    const record = encryptSecret('test', TEST_KEY);
    const parts = record.split(':');
    expect(parts.length).toBe(3);
    const [ivHex, tagHex, ciphertextB64] = parts;
    // ivHex = 12 bytes => 24 hex chars
    expect(ivHex).toMatch(/^[0-9a-f]{24}$/);
    // tagHex = 16 bytes => 32 hex chars
    expect(tagHex).toMatch(/^[0-9a-f]{32}$/);
    // ciphertextB64 is valid base64
    expect(() => Buffer.from(ciphertextB64!, 'base64')).not.toThrow();
    expect(ciphertextB64!.length).toBeGreaterThan(0);
  });

  it('encrypting same plaintext twice produces different records (random IV per write)', () => {
    const record1 = encryptSecret('same-value', TEST_KEY);
    const record2 = encryptSecret('same-value', TEST_KEY);
    expect(record1).not.toBe(record2);
  });

  it('decryptSecret throws a clear error on malformed record (missing parts)', () => {
    expect(() => decryptSecret('only-two:parts', TEST_KEY)).toThrow();
    expect(() => decryptSecret('', TEST_KEY)).toThrow();
  });
});

describe('maskSecret (DCFG-02, D2-06)', () => {
  it('returns bullet form ending with the last 4 chars of the value', () => {
    const masked = maskSecret('abcd1234');
    expect(masked.endsWith('1234')).toBe(true);
  });

  it('never contains middle bytes of the plaintext value', () => {
    const plain = 'sk-ant-api03-secretmiddle9999';
    const masked = maskSecret(plain);
    // last 4 is '9999'; middle is 'secretmiddle'
    expect(masked).not.toContain('secretmiddle');
    expect(masked).not.toContain('sk-ant');
    expect(masked.endsWith('9999')).toBe(true);
  });

  it('uses the U+2022 bullet character (not ASCII asterisk)', () => {
    const masked = maskSecret('test1234');
    expect(masked).toContain('•');
  });

  it('with a prefix, retains the prefix and last 4 chars', () => {
    const masked = maskSecret('sk-ant-api03-abcdef9999', 'sk-ant-');
    expect(masked.startsWith('sk-ant-')).toBe(true);
    expect(masked.endsWith('9999')).toBe(true);
    expect(masked).not.toContain('abcdef');
  });
});

describe('loadMachineKey (DCFG-02, D2-05)', () => {
  it('OPEN_REVIEW_SECRET_KEY of wrong byte length throws a clear error', () => {
    // 32 hex chars = 16 bytes, not 32 -- should throw
    const saved = process.env['OPEN_REVIEW_SECRET_KEY'];
    try {
      process.env['OPEN_REVIEW_SECRET_KEY'] = 'a'.repeat(32); // 16 bytes, not 32
      expect(() => loadMachineKey()).toThrow(/32/);
    } finally {
      if (saved === undefined) delete process.env['OPEN_REVIEW_SECRET_KEY'];
      else process.env['OPEN_REVIEW_SECRET_KEY'] = saved;
    }
  });

  it('OPEN_REVIEW_SECRET_KEY of correct length returns a 32-byte Buffer', () => {
    const saved = process.env['OPEN_REVIEW_SECRET_KEY'];
    try {
      // 64 hex chars = 32 bytes
      process.env['OPEN_REVIEW_SECRET_KEY'] = 'a'.repeat(64);
      const key = loadMachineKey();
      expect(Buffer.isBuffer(key)).toBe(true);
      expect(key.length).toBe(32);
    } finally {
      if (saved === undefined) delete process.env['OPEN_REVIEW_SECRET_KEY'];
      else process.env['OPEN_REVIEW_SECRET_KEY'] = saved;
    }
  });
});
