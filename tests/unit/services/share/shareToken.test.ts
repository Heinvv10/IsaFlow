import { describe, it, expect } from 'vitest';
import { mintShareToken, hashShareToken, isShareTokenShape } from '@/modules/accounting/services/share/shareToken';

describe('mintShareToken', () => {
  it('returns 43 base64url characters, which is 256 bits', () => {
    const t = mintShareToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('never repeats across a thousand mints', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(mintShareToken());
    expect(seen.size).toBe(1000);
  });
});

describe('hashShareToken', () => {
  it('is sha256 hex and is stable', () => {
    const h = hashShareToken('abc');
    expect(h).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('gives different hashes for tokens differing in one character', () => {
    expect(hashShareToken('a'.repeat(43))).not.toBe(hashShareToken('a'.repeat(42) + 'b'));
  });
});

describe('isShareTokenShape', () => {
  it('accepts a minted token', () => {
    expect(isShareTokenShape(mintShareToken())).toBe(true);
  });

  it('rejects the wrong length, the wrong alphabet, and non-strings', () => {
    expect(isShareTokenShape('a'.repeat(42))).toBe(false);
    expect(isShareTokenShape('a'.repeat(44))).toBe(false);
    expect(isShareTokenShape('a'.repeat(42) + '+')).toBe(false);
    expect(isShareTokenShape('a'.repeat(42) + '/')).toBe(false);
    expect(isShareTokenShape(null)).toBe(false);
    expect(isShareTokenShape(undefined)).toBe(false);
    expect(isShareTokenShape(12345)).toBe(false);
    expect(isShareTokenShape(['a'.repeat(43)])).toBe(false);
  });

  it("rejects a SQL-ish and a path-traversal payload so the route's 404 is unconditional", () => {
    expect(isShareTokenShape("' OR 1=1 --")).toBe(false);
    expect(isShareTokenShape('../../etc/passwd')).toBe(false);
  });
});
