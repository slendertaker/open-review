/**
 * AES-256-GCM secret encryption for the secrets table (DCFG-02, D2-05, D2-06).
 *
 * Record layout: ivHex:tagHex:ciphertextB64 stored as TEXT in the secrets table.
 * - ivHex: 24 hex chars (12-byte random IV, unique per encryption -- T-02-03)
 * - tagHex: 32 hex chars (16-byte GCM auth tag -- T-02-02)
 * - ciphertextB64: base64-encoded ciphertext
 *
 * Machine key sources (highest to lowest priority):
 * 1. OPEN_REVIEW_SECRET_KEY env var (64 hex chars -> 32 bytes) -- D2-05 installer path
 * 2. data/secret.key file (hex, mode 0o600) -- T-02-01 on-disk key
 * 3. Auto-generated on first run and persisted to data/secret.key
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';

/** Bullet character (U+2022) for masked secret previews (D2-06). */
const BULLET = '•';

/**
 * Encrypt a plaintext string with AES-256-GCM.
 * Uses a fresh 12-byte random IV per call to prevent IV reuse (T-02-03).
 * Returns a colon-delimited record: ivHex:tagHex:ciphertextB64.
 */
export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const tag = cipher.getAuthTag(); // call after final()
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted}`;
}

/**
 * Decrypt an AES-256-GCM record produced by encryptSecret.
 * Throws if the record is malformed, if the key is wrong, or if
 * the GCM auth tag fails (T-02-02: tampered ciphertext is rejected).
 */
export function decryptSecret(record: string, key: Buffer): string {
  const parts = record.split(':');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error(
      `Invalid secret record format: expected ivHex:tagHex:ciphertextB64, got ${parts.length} part(s)`,
    );
  }
  const [ivHex, tagHex, ciphertext] = parts as [string, string, string];
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag); // MUST be set before final() -- Pitfall 3
  let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

/**
 * Return a masked preview of a secret value (D2-06, T-02-04).
 * Default format: bullets followed by the last 4 chars (e.g. '••••9999').
 * With a prefix: prefix + bullets + last 4 chars (e.g. 'sk-ant-••••9999').
 * The bullet count is always 4 to avoid leaking value length.
 * The masked output never contains any character of the plaintext
 * except its final four.
 */
export function maskSecret(value: string, prefix?: string): string {
  // Only reveal the trailing 4 chars when the value is longer than 4 (WR-03):
  // value.slice(-4) on a value of length <= 4 returns the WHOLE string, which would
  // render a short secret in full and violate the masking contract above.
  const last4 = value.length > 4 ? value.slice(-4) : '';
  const bullets = BULLET.repeat(4);
  return prefix ? `${prefix}${bullets}${last4}` : `${bullets}${last4}`;
}

/**
 * Load (or generate) the 32-byte machine key used to encrypt secrets.
 *
 * Key source priority (D2-05):
 * 1. OPEN_REVIEW_SECRET_KEY env var: must be 64 hex chars (32 bytes). Preferred for
 *    production / systemd EnvironmentFile deployments.
 * 2. data/secret.key file: hex-encoded 32-byte key, written with mode 0o600 (T-02-01).
 *    Resolved against process.cwd() (Pitfall 7: document that WorkingDirectory must be
 *    set in the systemd unit; override with env var for unattended installs).
 * 3. Auto-generate: randomBytes(32) -> write to data/secret.key on first run.
 */
export function loadMachineKey(): Buffer {
  // Priority 1: env override (installer / systemd EnvironmentFile path)
  const envHex = process.env['OPEN_REVIEW_SECRET_KEY'];
  if (envHex) {
    const buf = Buffer.from(envHex, 'hex');
    if (buf.length !== 32) {
      throw new Error(
        `OPEN_REVIEW_SECRET_KEY must be 64 hex chars (32 bytes); got ${buf.length} bytes (${envHex.length} hex chars)`,
      );
    }
    return buf;
  }

  // Priority 2: key file on disk
  const keyPath = path.resolve(process.cwd(), 'data/secret.key');
  if (existsSync(keyPath)) {
    const hex = readFileSync(keyPath, 'utf8').trim();
    const buf = Buffer.from(hex, 'hex');
    if (buf.length !== 32) {
      throw new Error(
        `data/secret.key must contain 64 hex chars (32 bytes); got ${buf.length} bytes`,
      );
    }
    return buf;
  }

  // Priority 3: auto-generate on first run
  const key = randomBytes(32);
  mkdirSync(path.dirname(keyPath), { recursive: true });
  writeFileSync(keyPath, key.toString('hex'), { mode: 0o600 });
  return key;
}
