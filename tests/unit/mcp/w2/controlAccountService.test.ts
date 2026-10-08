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

  it('returns ONLY accounts typed for the role, and says so', async () => {
    // The posting arm is GONE. An account reached only because a subledger
    // journal touched it is not a control account: `settle_by_contra` posts
    // DR AP / CR <loan account> through a supplier_payments row, so the loan
    // account was adopted as an AP control account and brought its whole
    // balance into the control total. On production that produced three "AP
    // control accounts", controlAccountAmbiguous true, a
    // document_not_on_control_account item of +R453m and an unexplained
    // difference of -R437m.
    sqlFn.mockResolvedValueOnce([
      row({ total_debit: '14301397.60', total_credit: '2709774.00' }),
    ]);

    const accounts = await getControlAccountBalances(COMPANY, 'ar', '2026-09-03');

    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.foundBy).toBe('subtype');
  });

  it('binds no document table to the query — the posting probe is gone', async () => {
    // The unit suite mocks `sql`, so it cannot run the query; what it CAN see
    // is what the query was parameterised with. The probe arm bound every
    // document table it scanned, so their absence is evidence it is gone.
    // controlAccountSql.integration.test.ts runs the real thing.
    sqlFn.mockResolvedValueOnce([]);
    await getControlAccountBalances(COMPANY, 'ap', '2026-09-03');
    const values = sqlFn.mock.calls[0]!.slice(1).flat();
    for (const table of ['customer_invoices', 'customer_payments', 'credit_notes',
                         'supplier_invoices', 'supplier_payments']) {
      expect(values).not.toContain(table);
    }
  });

  it('signs the balance by account type: an asset debit less credit, a liability credit less debit', async () => {
    sqlFn.mockResolvedValueOnce([
      row({ total_debit: '100', total_credit: '30' }),
      row({
        id: '44444444-4444-4444-8444-444444444444',
        account_code: '2001',
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

  // `normal_balance` is user-set and is NOT the sign. These rows carry a
  // mis-set one ONLY to prove it is ignored: signed by it, the receivable would
  // read −100 and the payable −50, and the aging tie-out would compare the
  // subledger against a control balance pointing the wrong way.
  it('ignores a mis-set normal_balance — the account type decides the sign', async () => {
    sqlFn.mockResolvedValueOnce([
      row({ normal_balance: 'credit', total_debit: '100', total_credit: '0' }),
      row({
        id: '55555555-5555-4555-8555-555555555555',
        account_code: '2002',
        normal_balance: 'debit',
        account_type: 'liability',
        account_subtype: 'payable',
        total_debit: '0',
        total_credit: '50',
      }),
    ]);

    const accounts = await getControlAccountBalances(COMPANY, 'ap', '2026-09-03');
    expect(accounts[0]!.balance).toBe(100);
    expect(accounts[1]!.balance).toBe(50);
  });

  it('leaves the vat role unchanged for normally configured accounts', async () => {
    // Input VAT is a debit-normal asset, output VAT a credit-normal liability:
    // by type and by normal_balance they read the same. Netting the two is the
    // reconciler's business (subledgerReconciliationService), not this one's.
    sqlFn.mockResolvedValueOnce([
      row({ account_subtype: 'vat_input', normal_balance: 'debit', total_debit: '100', total_credit: '0' }),
      row({
        id: '66666666-6666-4666-8666-666666666666',
        account_code: '2200',
        account_subtype: 'vat_output',
        normal_balance: 'credit',
        account_type: 'liability',
        total_debit: '20',
        total_credit: '170',
      }),
    ]);

    const accounts = await getControlAccountBalances(COMPANY, 'vat', '2026-09-03');
    expect(accounts.map((a) => a.balance)).toEqual([100, 150]);
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
