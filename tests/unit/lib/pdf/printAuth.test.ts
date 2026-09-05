/**
 * Print token: HMAC-SHA256 over company_id|user_id|path|exp.
 *
 * Boundary tests:
 *   - Round-trip: mint → verify → payload matches
 *   - Rejects an expired token
 *   - Rejects a token presented against a different path
 *   - Rejects a tampered signature
 *   - Disabled entirely when PRINT_TOKEN_SECRET is unset
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mintPrintToken, verifyPrintToken } from '@/lib/pdf/printAuth';

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
    const token = mintPrintToken(companyId, userId, path, 120);
    const verified = verifyPrintToken(token, path);
    expect(verified).toEqual({
      companyId,
      userId,
      path,
      exp: expect.any(Number),
    });
  });
});

describe('printAuth — rejection', () => {
  it('rejects an expired token', () => {
    const token = mintPrintToken(companyId, userId, path, -1);
    expect(verifyPrintToken(token, path)).toBeNull();
  });

  it('rejects a token presented against a different path', () => {
    const token = mintPrintToken(companyId, userId, path, 120);
    expect(verifyPrintToken(token, '/api/accounting/reports-balance-sheet')).toBeNull();
  });

  it('rejects a tampered signature', () => {
    const token = mintPrintToken(companyId, userId, path, 120);
    const [payload] = token.split('.');
    const tampered = `${payload}.${'0'.repeat(64)}`;
    expect(verifyPrintToken(tampered, path)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const token = mintPrintToken(companyId, userId, path, 120);
    process.env.PRINT_TOKEN_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    expect(verifyPrintToken(token, path)).toBeNull();
  });

  it('is disabled entirely when PRINT_TOKEN_SECRET is unset', () => {
    const token = mintPrintToken(companyId, userId, path, 120);
    delete process.env.PRINT_TOKEN_SECRET;
    expect(verifyPrintToken(token, path)).toBeNull();
  });

  it('rejects a malformed token', () => {
    expect(verifyPrintToken('not-a-real-token', path)).toBeNull();
    expect(verifyPrintToken('a.b.c', path)).toBeNull();
  });

  it('throws when minting without PRINT_TOKEN_SECRET set', () => {
    delete process.env.PRINT_TOKEN_SECRET;
    expect(() => mintPrintToken(companyId, userId, path, 120)).toThrow();
  });
});
