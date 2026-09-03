/**
 * Control-account resolution (W2).
 *
 * There is NO canonical AR/AP control account in this schema — 13 accounts
 * carry subtype='receivable' across the estate and one carries NULL. On
 * Brightsphere production a R10,000 receipt was credited to account 1120,
 * whose subtype is NULL, while every other receipt went to 1101. A resolver
 * that picks one account by subtype misses that R10,000 and reports a clean
 * reconciliation over an incomplete control balance.
 *
 * So the resolver returns EVERY candidate, found two ways, and says which way
 * each was found. Deciding which one *should* be canonical is a business call
 * (FINDINGS C1, owner Hein); surfacing that there is more than one is this
 * function's whole job.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlFn = vi.fn();
vi.mock('@/lib/neon', () => ({
  sql: (...args: unknown[]) => sqlFn(...args),
  withTransaction: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  getControlAccountBalances,
  SUBLEDGER_ROLES,
} from '@/modules/accounting/services/gl/controlAccountService';

const COMPANY = '11111111-1111-4111-8111-111111111111';

function row(over: Record<string, unknown>) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    account_code: '1101',
    account_name: 'Trade Debtors Control',
    account_subtype: 'receivable',
    account_type: 'asset',
    normal_balance: 'debit',
    is_active: true,
    total_debit: '0',
    total_credit: '0',
    found_by: 'subtype',
    ...over,
  };
}

beforeEach(() => {
  sqlFn.mockReset();
});

describe('getControlAccountBalances', () => {
  it('names every subledger role the reconciler accepts', () => {
    expect([...SUBLEDGER_ROLES]).toEqual(['ar', 'ap', 'bank', 'vat', 'payroll', 'inventory']);
  });

  it('returns an account found only by its POSTINGS, not by its subtype', async () => {
    // 1120 carries a NULL subtype and would be invisible to a subtype filter.
    sqlFn.mockResolvedValueOnce([
      row({ total_debit: '14301397.60', total_credit: '2709774.00' }),
      row({
        id: '33333333-3333-4333-8333-333333333333',
        account_code: '1120',
        account_name: 'Accounts Receivable',
        account_subtype: null,
        total_debit: '0',
        total_credit: '10000',
        found_by: 'posting',
      }),
    ]);

    const accounts = await getControlAccountBalances(COMPANY, 'ar', '2026-09-03');

    expect(accounts).toHaveLength(2);
    expect(accounts[1]).toMatchObject({
      accountCode: '1120',
      accountSubtype: null,
      foundBy: 'posting',
      balance: -10000,
    });
  });

  it('signs the balance in the account normal direction', async () => {
    sqlFn.mockResolvedValueOnce([
      row({ normal_balance: 'debit', total_debit: '100', total_credit: '30' }),
      row({
        id: '44444444-4444-4444-8444-444444444444',
        account_code: '2001',
        normal_balance: 'credit',
        account_type: 'liability',
        account_subtype: 'payable',
        total_debit: '30',
        total_credit: '100',
      }),
    ]);

    const accounts = await getControlAccountBalances(COMPANY, 'ap', '2026-09-03');
    expect(accounts[0]!.balance).toBe(70);
    expect(accounts[1]!.balance).toBe(70);
  });

  it('keeps a DEACTIVATED account that carries a balance', async () => {
    // gl_accounts.is_active is a picker flag. Four inactive production accounts
    // hold R137,317.39 between them, R6,550 of it cash. Filtering on it inside
    // a balance query is the defect (FINDINGS B4/B5), not the tidy-up.
    sqlFn.mockResolvedValueOnce([
      row({ is_active: false, total_debit: '130000', total_credit: '0' }),
    ]);

    const accounts = await getControlAccountBalances(COMPANY, 'ar', '2026-09-03');
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ isActive: false, balance: 130000 });
  });

  it('scopes every query by the company it was given', async () => {
    sqlFn.mockResolvedValueOnce([]);
    await getControlAccountBalances(COMPANY, 'ar', '2026-09-03');
    // The tagged template hands values as trailing arguments.
    expect(sqlFn.mock.calls[0]!.slice(1)).toContain(COMPANY);
  });

  it('passes the as-at date through as a string, never a Date', async () => {
    sqlFn.mockResolvedValueOnce([]);
    await getControlAccountBalances(COMPANY, 'ar', '2026-02-28');
    const values = sqlFn.mock.calls[0]!.slice(1);
    expect(values).toContain('2026-02-28');
    expect(values.every((v) => !(v instanceof Date))).toBe(true);
  });
});
