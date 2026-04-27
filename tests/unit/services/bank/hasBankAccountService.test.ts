/**
 * Unit tests for hasBankAccountService.
 *
 * Verifies:
 *   1. Returns true when a bank GL account exists for the company
 *   2. Returns false when none exists
 *   3. company_id is the first interpolated argument (multi-tenant safety)
 *   4. Cross-tenant isolation: different companyId → different result
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: Object.assign(vi.fn(), { unsafe: vi.fn() }),
}));

vi.mock('@/lib/neon', () => ({
  sql: sqlMock,
}));

import { hasBankAccount } from '@/modules/accounting/services/bank/hasBankAccountService';

const COMPANY_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const COMPANY_B = 'bbbbbbbb-0000-0000-0000-000000000002';

beforeEach(() => {
  sqlMock.mockReset();
});

describe('hasBankAccount', () => {
  it('returns true when a bank GL account exists for the company', async () => {
    sqlMock.mockResolvedValueOnce([{ has_bank_account: true }]);

    const result = await hasBankAccount(COMPANY_A);

    expect(result).toBe(true);
  });

  it('returns false when no bank GL account exists for the company', async () => {
    sqlMock.mockResolvedValueOnce([{ has_bank_account: false }]);

    const result = await hasBankAccount(COMPANY_A);

    expect(result).toBe(false);
  });

  it('returns false when the DB returns an empty row array', async () => {
    sqlMock.mockResolvedValueOnce([]);

    const result = await hasBankAccount(COMPANY_A);

    expect(result).toBe(false);
  });

  it('passes companyId as the first interpolated argument', async () => {
    sqlMock.mockResolvedValueOnce([{ has_bank_account: false }]);

    await hasBankAccount(COMPANY_A);

    // sql`` is called as a tagged template; the mock receives the strings
    // array as the first argument and interpolated values as the rest.
    const [_strings, firstInterpolation] = sqlMock.mock.calls[0];
    expect(_strings).toBeDefined(); // template strings array
    expect(firstInterpolation).toBe(COMPANY_A);
  });

  it('cross-tenant: different companyId → different result (branching mock)', async () => {
    sqlMock.mockImplementation((_template: TemplateStringsArray, ...args: unknown[]) => {
      const companyId = args[0] as string;
      if (companyId === COMPANY_A) return Promise.resolve([{ has_bank_account: true }]);
      if (companyId === COMPANY_B) return Promise.resolve([{ has_bank_account: false }]);
      return Promise.resolve([]);
    });

    const a = await hasBankAccount(COMPANY_A);
    const b = await hasBankAccount(COMPANY_B);

    expect(a).toBe(true);
    expect(b).toBe(false);
  });
});
