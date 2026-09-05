/**
 * Print token: HMAC-SHA256 over company_id|user_id|paths|exp.
 *
 * Boundary tests:
 *   - Round-trip: mint → verify → payload matches
 *   - Rejects an expired token
 *   - Rejects a token presented against a path outside its bound set
 *   - Rejects a tampered signature
 *   - Disabled entirely when PRINT_TOKEN_SECRET is unset
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mintPrintToken, verifyPrintToken, verifyPrintTokenSignature } from '@/lib/pdf/printAuth';

const ORIGINAL_SECRET = process.env.PRINT_TOKEN_SECRET;
const TEST_SECRET = '0123456789abcdef0123456789abcdef';

const companyId = '00000000-0000-0000-0000-000000000001';
const userId = '00000000-0000-0000-0000-000000000002';
const path = '/api/accounting/reports-management-accounts';

beforeEach(() => {
  process.env.PRINT_TOKEN_SECRET = TEST_SECRET;
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.PRINT_TOKEN_SECRET;
  else process.env.PRINT_TOKEN_SECRET = ORIGINAL_SECRET;
});

describe('printAuth — round trip', () => {
  it('mints and verifies a valid token', () => {
    const token = mintPrintToken(companyId, userId, [path], 120);
    const verified = verifyPrintToken(token, path);
    expect(verified).toEqual({
      companyId,
      userId,
      paths: [path],
      exp: expect.any(Number),
    });
  });
});

describe('printAuth — rejection', () => {
  it('rejects an expired token', () => {
    const token = mintPrintToken(companyId, userId, [path], -1);
    expect(verifyPrintToken(token, path)).toBeNull();
  });

  it('rejects a token presented against a different path', () => {
    const token = mintPrintToken(companyId, userId, [path], 120);
    expect(verifyPrintToken(token, '/api/accounting/reports-balance-sheet')).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const token = mintPrintToken(companyId, userId, [path], 120);
    const [payload] = token.split('.');
    const tampered = `${payload}.${'0'.repeat(64)}`;
    expect(verifyPrintToken(tampered, path)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = mintPrintToken(companyId, userId, [path], 120);
    process.env.PRINT_TOKEN_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(verifyPrintToken(token, path)).toBeNull();
  });

  it('is disabled entirely when PRINT_TOKEN_SECRET is unset', () => {
    const token = mintPrintToken(companyId, userId, [path], 120);
    delete process.env.PRINT_TOKEN_SECRET;
    expect(verifyPrintToken(token, path)).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(verifyPrintToken('not-a-real-token', path)).toBeNull();
    expect(verifyPrintToken('a.b.c', path)).toBeNull();
  });

  it('throws when minting without PRINT_TOKEN_SECRET set', () => {
    delete process.env.PRINT_TOKEN_SECRET;
    expect(() => mintPrintToken(companyId, userId, [path], 120)).toThrow();
  });

  it('rejects (verify) and throws (mint) when PRINT_TOKEN_SECRET is shorter than 32 chars', () => {
    process.env.PRINT_TOKEN_SECRET = 'too-short';
    expect(() => mintPrintToken(companyId, userId, [path], 120)).toThrow();

    // Mint one under the valid secret, then shrink the secret and verify —
    // the too-short secret must fail closed on the read side too, not just
    // refuse to mint.
    process.env.PRINT_TOKEN_SECRET = TEST_SECRET;
    const token = mintPrintToken(companyId, userId, [path], 120);
    process.env.PRINT_TOKEN_SECRET = 'too-short';
    expect(verifyPrintToken(token, path)).toBeNull();
  });
});

describe('printAuth — verifyPrintTokenSignature (no path check)', () => {
  it('accepts a signed, unexpired token regardless of path — path is checked separately by the caller', () => {
    const token = mintPrintToken(companyId, userId, [path], 120);
    const candidate = verifyPrintTokenSignature(token);
    expect(candidate).toEqual({ companyId, userId, paths: [path], exp: expect.any(Number) });
  });

  it('still rejects an expired or tampered token', () => {
    const expired = mintPrintToken(companyId, userId, [path], -1);
    expect(verifyPrintTokenSignature(expired)).toBeNull();

    const token = mintPrintToken(companyId, userId, [path], 120);
    const [payload] = token.split('.');
    expect(verifyPrintTokenSignature(`${payload}.${'0'.repeat(64)}`)).toBeNull();
  });
});

describe('multi-path print tokens', () => {
  const COMPANY = companyId;
  const USER = userId;
  const PACK = '/api/accounting/reports-pack';
  const TREND = '/api/accounting/packs/management/trend';

  it('authorises every path in the set', () => {
    const token = mintPrintToken(COMPANY, USER, [PACK, TREND]);
    expect(verifyPrintToken(token, PACK)?.companyId).toBe(COMPANY);
    expect(verifyPrintToken(token, TREND)?.companyId).toBe(COMPANY);
  });

  it('rejects a path that is not in the set', () => {
    const token = mintPrintToken(COMPANY, USER, [PACK, TREND]);
    expect(verifyPrintToken(token, '/api/accounting/reports-balance-sheet')).toBeNull();
  });

  it('matches exactly, never by prefix', () => {
    const token = mintPrintToken(COMPANY, USER, [PACK]);
    // A prefix match here would authorise every route that merely starts with
    // the bound path — a 2-minute report token becoming a general API key.
    expect(verifyPrintToken(token, `${PACK}-secret`)).toBeNull();
    expect(verifyPrintToken(token, '/api/accounting/reports')).toBeNull();
    expect(verifyPrintToken(token, `${PACK}/sub`)).toBeNull();
  });

  it('signs the whole set, so a path cannot be appended to a minted token', () => {
    const token = mintPrintToken(COMPANY, USER, [PACK]);
    const [payloadB64, sig] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64!, 'base64url').toString('utf8'));
    payload.paths.push('/api/accounting/customers');
    const forged = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${sig}`;
    expect(verifyPrintToken(forged, '/api/accounting/customers')).toBeNull();
    expect(verifyPrintTokenSignature(forged)).toBeNull();
  });

  it('refuses to mint a token with no paths, a wildcard, or a query string', () => {
    expect(() => mintPrintToken(COMPANY, USER, [])).toThrow(/at least one path/);
    expect(() => mintPrintToken(COMPANY, USER, ['*'])).toThrow(/absolute API path/);
    expect(() => mintPrintToken(COMPANY, USER, ['/api/x?y=1'])).toThrow(/absolute API path/);
    expect(() => mintPrintToken(COMPANY, USER, ['/api/a\n/api/b'])).toThrow(/absolute API path/);
  });

  // The signature is an HMAC over paths.join('\n'), so ['/a\n/b'] and
  // ['/a', '/b'] would hash identically. Without the parser's separator guard
  // one set's signature validates the other's payload — a forged payload that
  // passes verifyPrintTokenSignature.
  it('rejects a payload whose path contains the signing separator', () => {
    const token = mintPrintToken(COMPANY, USER, [PACK, TREND]);
    const [, sig] = token.split('.');
    const original = JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'));
    const collided = Buffer.from(
      JSON.stringify({ ...original, paths: [`${PACK}\n${TREND}`] }),
    ).toString('base64url');
    expect(verifyPrintTokenSignature(`${collided}.${sig}`)).toBeNull();
  });

  it('rejects a payload whose paths field is not an array of strings', () => {
    const token = mintPrintToken(COMPANY, USER, [PACK]);
    const [, sig] = token.split('.');
    const bad = Buffer.from(JSON.stringify({ companyId: COMPANY, userId: USER, paths: PACK, exp: 9e9 })).toString('base64url');
    expect(verifyPrintTokenSignature(`${bad}.${sig}`)).toBeNull();
  });
});
