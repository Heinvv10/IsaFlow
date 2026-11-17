/**
 * Upload tokens are self-authenticating: 16 random bytes and a 16-byte HMAC tag (key derived from JWT_SECRET for this
 * purpose only), base64url, 43 characters. Load-bearing: a minted token verifies; one flipped character, another key,
 * a wrong length or random bytes do not; with no JWT_SECRET nothing is minted and nothing verifies (never unkeyed).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import { newUploadToken, uploadTokenKeyAvailable, verifyUploadToken } from '@/lib/mcp/uploadToken';

const saved = process.env.JWT_SECRET;
afterEach(() => { process.env.JWT_SECRET = saved; });
const withKey = (k: string | undefined) => { if (k === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = k; };

describe('upload tokens', () => {
  it('mints 43-character tokens that verify, with token_hash the sha256 of the whole token', () => {
    withKey('unit-test-only-key-a');
    const { token, tokenHash } = newUploadToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toBe(createHash('sha256').update(token, 'utf8').digest('hex'));
    expect(verifyUploadToken(token)).toBe(true);
    expect(newUploadToken().token).not.toBe(token);
  });

  it('refuses a flipped character, another key, random bytes and the wrong length', () => {
    withKey('unit-test-only-key-a');
    const { token } = newUploadToken();
    for (const i of [0, 15, 21, 30, 42]) {
      const flipped = token.slice(0, i) + (token[i] === 'A' ? 'B' : 'A') + token.slice(i + 1);
      expect(verifyUploadToken(flipped)).toBe(false);
    }
    expect(verifyUploadToken(randomBytes(32).toString('base64url'))).toBe(false);
    expect(verifyUploadToken(token.slice(0, 42))).toBe(false);
    expect(verifyUploadToken(`${token}A`)).toBe(false);
    expect(verifyUploadToken('')).toBe(false);
    withKey('unit-test-only-key-b');
    expect(verifyUploadToken(token)).toBe(false);
  });

  it('mints nothing and verifies nothing without a server key', () => {
    withKey('unit-test-only-key-a');
    const { token } = newUploadToken();
    withKey(undefined);
    expect(uploadTokenKeyAvailable()).toBe(false);
    expect(() => newUploadToken()).toThrow();
    expect(verifyUploadToken(token)).toBe(false);
    withKey('');
    expect(uploadTokenKeyAvailable()).toBe(false);
  });
});
