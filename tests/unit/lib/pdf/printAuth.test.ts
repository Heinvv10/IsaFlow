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
import { createHmac } from 'crypto';
import { mintPrintToken, verifyPrintToken, verifyPrintTokenSignature } from '@/lib/pdf/printAuth';

/**
 * The signature `printAuth.sign` produces, rebuilt here. Needed because the
 * collision tests below sign tuples the minter now REFUSES to mint — which is
 * the point: an attacker does not go through the minter, and the parser is
 * the side that has to hold. Mirrors sign() exactly: `company|user|paths|exp`
 * with paths joined on a newline.
 */
function signLikeMinter(companyId: string, userId: string, paths: string[], exp: number): string {
  return createHmac('sha256', process.env.PRINT_TOKEN_SECRET as string)
    .update(`${companyId}|${userId}|${paths.join('\n')}|${exp}`)
    .digest('hex');
}

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

  // M1: the signed string is `company|user|paths|exp`, so a `|` inside a path
  // makes the tuple re-splittable — one HMAC, two readings.
  it('rejects a path containing the field separator, on both mint and verify', () => {
    expect(() => mintPrintToken(COMPANY, USER, ['/api/a|/api/b'])).toThrow(/absolute API path/);

    // Verify side — a genuine signature that reads as two different tuples.
    // `sign` builds `company|user|paths|exp`, so a token minted for userId
    // `U|PACK` with paths [TREND] signs exactly the same string as a payload
    // claiming userId `U` with paths ['PACK|TREND']. The minter now refuses
    // that userId (see the collision test below), so the signature is built
    // here the way any holder of the secret could build it — the guard that
    // has to catch it lives in the parser, on the side an attacker reaches.
    const exp = Math.floor(Date.now() / 1000) + 120;
    const sig = signLikeMinter(COMPANY, `${USER}|${PACK}`, [TREND], exp);
    const collided = Buffer.from(
      JSON.stringify({ companyId: COMPANY, userId: USER, paths: [`${PACK}|${TREND}`], exp }),
    ).toString('base64url');
    expect(verifyPrintTokenSignature(`${collided}.${sig}`)).toBeNull();
  });

  /**
   * LOW-1: `sign` was non-injective in the OTHER two fields. The separator ban
   * covered `paths` only, so company `c|u` + user `x` produced exactly the
   * signed string of company `c` + user `u|x` — one genuine signature
   * validating a payload that names a different company. On a multi-tenant
   * ledger that is a cross-tenant read, not a formatting defect.
   */
  describe('LOW-1 — the signing separators are banned in every signed field', () => {
    const C = 'company-c';
    const U = 'user-u';
    const X = 'user-x';

    it('proves the collision exists at the HMAC level', () => {
      // The two tuples are DIFFERENT and their signed strings are IDENTICAL.
      const exp = 9_000_000_000;
      expect(signLikeMinter(`${C}${'|'}${U}`, X, [PACK], exp))
        .toBe(signLikeMinter(C, `${U}|${X}`, [PACK], exp));
    });

    it('refuses to mint a companyId or userId containing either separator', () => {
      expect(() => mintPrintToken(`${C}|${U}`, X, [PACK])).toThrow(/signing separators/);
      expect(() => mintPrintToken(C, `${U}|${X}`, [PACK])).toThrow(/signing separators/);
      expect(() => mintPrintToken(`${C}\n${U}`, X, [PACK])).toThrow(/signing separators/);
      expect(() => mintPrintToken(C, `${U}\n${X}`, [PACK])).toThrow(/signing separators/);
    });

    it('rejects the colliding payload on verify, with the genuine signature', () => {
      const exp = Math.floor(Date.now() / 1000) + 120;
      // A signature legitimately produced for company `c|u`, user `x`.
      const sig = signLikeMinter(`${C}|${U}`, X, [PACK], exp);
      // The SAME bytes read as company `c`, user `u|x` — a different tenant.
      const forged = Buffer.from(
        JSON.stringify({ companyId: C, userId: `${U}|${X}`, paths: [PACK], exp }),
      ).toString('base64url');
      expect(verifyPrintTokenSignature(`${forged}.${sig}`)).toBeNull();
      expect(verifyPrintToken(`${forged}.${sig}`, PACK)).toBeNull();
    });
  });

  // M2: the mint side accepts only an already-normalised absolute pathname.
  it('refuses to mint a path that is not already normalised', () => {
    const rejected = [
      '/api/accounting/../admin',        // traversal
      '/api/accounting//reports-pack',   // double slash
      '/api/accounting/reports%2Fpack',  // percent-encoded separator
      '/api/accounting/%2e%2e/admin',    // percent-encoded traversal
      '//evil.example.com/api',          // authority form
      '/api/accounting/\u200Breports',   // zero-width space, which \s does not match
      '/api/accounting/\u0000reports',    // NUL
      'api/accounting/reports-pack',     // relative
    ];
    for (const p of rejected) {
      expect(() => mintPrintToken(COMPANY, USER, [p])).toThrow(/absolute API path/);
    }
    // The real pack paths still mint.
    expect(() => mintPrintToken(COMPANY, USER, [PACK, TREND])).not.toThrow();
  });

  // M3: variants that must not be treated as the bound path.
  it('rejects a trailing-slash or case-differing variant of a bound path', () => {
    const token = mintPrintToken(COMPANY, USER, [PACK]);
    expect(verifyPrintToken(token, `${PACK}/`)).toBeNull();
    expect(verifyPrintToken(token, PACK.toUpperCase())).toBeNull();
  });

  it('rejects a payload whose paths field is not an array of strings', () => {
    const token = mintPrintToken(COMPANY, USER, [PACK]);
    const [, sig] = token.split('.');
    const bad = Buffer.from(JSON.stringify({ companyId: COMPANY, userId: USER, paths: PACK, exp: 9e9 })).toString('base64url');
    expect(verifyPrintTokenSignature(`${bad}.${sig}`)).toBeNull();
  });
});

/**
 * ADVERSARIAL LOW-11: a token must have exactly ONE valid spelling.
 *
 * Both decoders are forgiving in ways the HMAC cannot see: `Buffer.from(x,
 * 'hex')` accepts uppercase, and `Buffer.from(x, 'base64url')` accepts
 * standard base64 (`+`, `/`), `=` padding, and trailing bits that do not
 * round-trip. Each is a DIFFERENT string that verifies against the same
 * secret, so one authority arrives wearing several faces — and the token has
 * no nonce and no revocation, so string identity is the only handle anything
 * upstream has on it: a rate-limit key, a replay cache, an operator grepping
 * the logs for a leaked token.
 */
describe('printAuth — only the canonical encoding verifies', () => {
  const canonical = () => mintPrintToken(companyId, userId, [path], 120);

  it('accepts the token as minted', () => {
    expect(verifyPrintTokenSignature(canonical())).not.toBeNull();
  });

  it('rejects an uppercased signature that is otherwise identical', () => {
    const [payload, sig] = canonical().split('.');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyPrintTokenSignature(`${payload}.${sig!.toUpperCase()}`)).toBeNull();
    // Even one uppercased character is a different spelling of the same value.
    const mixed = sig!.replace(/[a-f]/, (c) => c.toUpperCase());
    expect(mixed).not.toBe(sig);
    expect(verifyPrintTokenSignature(`${payload}.${mixed}`)).toBeNull();
  });

  it('rejects a signature of the wrong length, truncated or padded', () => {
    const [payload, sig] = canonical().split('.');
    expect(verifyPrintTokenSignature(`${payload}.${sig!.slice(0, 62)}`)).toBeNull();
    expect(verifyPrintTokenSignature(`${payload}.${sig}00`)).toBeNull();
    expect(verifyPrintTokenSignature(`${payload}.`)).toBeNull();
  });

  it('rejects a non-hex signature rather than letting the decoder truncate it', () => {
    const [payload, sig] = canonical().split('.');
    // Buffer.from(hex) stops at the first invalid pair, so without a charset
    // check this decodes to a short buffer instead of being refused.
    expect(verifyPrintTokenSignature(`${payload}.${sig!.slice(0, 8)}zz${sig!.slice(10)}`)).toBeNull();
  });

  it('rejects a standard-base64 payload where base64url is the encoding', () => {
    const [payload, sig] = canonical().split('.');
    const standard = Buffer.from(payload!, 'base64url').toString('base64');
    // Only meaningful if the two spellings actually differ for this payload.
    if (standard.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_') === payload) {
      expect(standard).not.toBe(payload); // padding alone still differs
    }
    expect(verifyPrintTokenSignature(`${standard}.${sig}`)).toBeNull();
  });

  it('rejects a padded payload', () => {
    const [payload, sig] = canonical().split('.');
    expect(verifyPrintTokenSignature(`${payload}=.${sig}`)).toBeNull();
    expect(verifyPrintTokenSignature(`${payload}==.${sig}`)).toBeNull();
  });

  it('rejects a trailing-bit variant that decodes to the same bytes', () => {
    const [payload, sig] = canonical().split('.');
    const decoded = Buffer.from(payload!, 'base64url');
    // Find a last character that decodes identically but is spelled otherwise
    // — that is exactly the non-canonical form the round-trip check catches.
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const variants = ALPHABET.split('')
      .map((c) => payload!.slice(0, -1) + c)
      .filter((v) => v !== payload && Buffer.from(v, 'base64url').equals(decoded));

    expect(variants.length, 'this payload has a non-canonical spelling to test').toBeGreaterThan(0);
    for (const v of variants) expect(verifyPrintTokenSignature(`${v}.${sig}`)).toBeNull();
  });
});
