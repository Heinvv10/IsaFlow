/**
 * Net pay credits the account that holds the company's BANK system role, not
 * the literal code '1110'.
 *
 * Production, Velocity Fibre 2026-10-27: 1110 was deactivated and the bank role
 * moved to 1544331 (an ABSA account). The plan still credited '1110', so the
 * October run carried an `inactive_target_account` blocker and could never be
 * approved. The plan now asks the system account resolver — the same answer
 * every other auto-posting gets — and the poster writes the plan's account id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';
import {
  answerHeaderGuard, glAccount, selectGlAccounts, type GlAccountRow,
} from '../../../helpers/glAccountsTableMock';

let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> =
  () => Promise.resolve([]);

vi.mock('@/lib/neon', () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => mockImpl(strings, ...values);
  return { sql, withTransaction: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) };
});
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// The poster locks the run header first (its own tests: payrollJournalPosterLock.test.ts); this file's neon mock has no withTransaction.
vi.mock('@/modules/accounting/services/payroll/payrollRunLock', () => ({
  lockPayrollRunHeader: vi.fn(async () => ({ id: 'run', journal_entry_id: null })),
  lockCompanyPayrollApprovals: vi.fn(async () => undefined),
}));
vi.mock('@/modules/accounting/services/payroll/costCentreGlMappingService', () => ({
  getMappingLookup: vi.fn(async () => ({})),
}));
const getSystemAccount = vi.fn();
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: (...args: unknown[]) => getSystemAccount(...args),
}));

import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { postPayrollRunJournal } from '@/modules/accounting/services/payroll/payrollJournalPostingService';

const createJournalEntry = vi.fn(async () => ({ id: 'je-1' }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  createJournalEntry: (...args: unknown[]) => (createJournalEntry as (...a: unknown[]) => unknown)(...args),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({
  postJournalEntry: vi.fn(async () => undefined),
  reverseJournalEntry: vi.fn(),
}));

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const RUN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

const HEADER = {
  id: RUN, company_id: COMPANY, period_month: 10, period_year: 2026, status: 'approved',
  journal_entry_id: null, total_gross: 100000, total_paye: 20000, total_uif: 2000,
  total_sdl: 1000, total_eti: 0, total_net: 76000, employee_count: 4,
};

const acc = (code: string, id: string, name: string, over: Partial<GlAccountRow> = {}, company = COMPANY): GlAccountRow =>
  glAccount({ id, company_id: company, account_code: code, account_name: name, ...over });

const PAYROLL_ACCOUNTS = [
  acc('5200', 'acc-5200', 'Labour Costs'),
  acc('2140', 'acc-2140', 'PAYE Payable'),
  acc('2150', 'acc-2150', 'UIF Payable'),
  acc('2160', 'acc-2160', 'SDL Payable'),
  acc('2175', 'acc-2175', 'Other Employee Deductions Payable'),
];
const bank = (code: string, id: string, name: string, over: Partial<GlAccountRow> = {}) =>
  acc(code, id, name, { account_subtype: 'bank', is_system_account: true, ...over });
/** Another tenant, in the same table: a query that drops its company filter finds these. */
const OTHER_TENANT = [
  ...PAYROLL_ACCOUNTS.map((a) => acc(a.account_code, `other-${a.id}`, a.account_name, {}, OTHER)),
  bank('1110', 'other-bank', 'Other Bank', {}),
  bank('1999999', 'other-bank-2', 'Other Bank 2', {}),
].map((a) => ({ ...a, company_id: OTHER }));
/** Velocity Fibre after 2026-10-27: 1110 deactivated, 1544331 holds the bank role. */
const MOVED = [...PAYROLL_ACCOUNTS, bank('1110', 'acc-1110', 'Bank - Primary', { is_active: false }), bank('1544331', 'acc-bank', 'ABSA Cheque')];
const UNMOVED = [...PAYROLL_ACCOUNTS, bank('1110', 'acc-1110', 'Bank - Primary')];

function routeMock(accounts: GlAccountRow[], header: Record<string, unknown> = HEADER) {
  const table = [...accounts, ...OTHER_TENANT];
  mockImpl = (strings, ...values) => {
    const q = strings.join('?');
    if (q.includes('payroll_run_headers')) {
      return Promise.resolve(values.includes(RUN) && values.includes(COMPANY) ? [header] : []);
    }
    if (q.includes('parent_account_id')) return Promise.resolve(answerHeaderGuard(table, strings, values));
    if (q.includes('FROM gl_accounts')) return Promise.resolve(selectGlAccounts(table, strings, values));
    return Promise.resolve([]);
  };
}

const holder = (id: string, code: string, name: string) => ({ id, accountCode: code, accountName: name });

beforeEach(() => {
  getSystemAccount.mockReset();
  createJournalEntry.mockClear();
  mockImpl = () => Promise.resolve([]);
});

describe('payroll net pay — the bank role holder', () => {
  it('credits the account holding the bank role when it moved off 1110', async () => {
    routeMock(MOVED);
    getSystemAccount.mockResolvedValue(holder('acc-bank', '1544331', 'ABSA Cheque'));

    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(getSystemAccount).toHaveBeenCalledWith('bank', COMPANY);
    const net = plan!.lines.find((l) => l.description === 'Net pay — bank disbursement');
    expect(net).toMatchObject({
      glAccountId: 'acc-bank', accountCode: '1544331', accountName: 'ABSA Cheque',
      debit: 0, credit: 76000, inactiveAccount: false,
    });
    expect(plan!.lines.map((l) => l.accountCode)).not.toContain('1110');
    // The October run's blocker is gone: nothing deactivated is targeted.
    expect(plan!.blockers).toEqual([]);
    expect(plan!.totalDebit).toBeCloseTo(plan!.totalCredit, 2);
  });

  it('the live poster writes the resolved account id, not a code lookup', async () => {
    // A pre-R-035 approved run (migration 951): clears the approval gate without a plan hash.
    routeMock(MOVED, { ...HEADER, approval_grandfathered_at: '2026-10-01T00:00:00Z' });
    getSystemAccount.mockResolvedValue(holder('acc-bank', '1544331', 'ABSA Cheque'));

    await postPayrollRunJournal(COMPANY, RUN, 'user-1');

    const input = (createJournalEntry.mock.calls[0] as unknown as [string, { lines: Array<{ glAccountId: string; credit: number }> }])[1];
    expect(input.lines.find((l) => l.credit === 76000)?.glAccountId).toBe('acc-bank');
    expect(input.lines.map((l) => l.glAccountId)).not.toContain('acc-1110');
  });

  it('is unchanged for a company whose bank role IS 1110', async () => {
    routeMock(UNMOVED);
    getSystemAccount.mockResolvedValue(holder('acc-1110', '1110', 'Bank - Primary'));

    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(plan!.blockers).toEqual([]);
    expect(plan!.lines).toEqual([
      { glAccountId: 'acc-5200', accountCode: '5200', accountName: 'Labour Costs', debit: 102000, credit: 0, description: 'Labour costs — gross pay + employer contributions (UIF, SDL, medical scheme) − ETI', inactiveAccount: false, cc1Id: null },
      { glAccountId: 'acc-2140', accountCode: '2140', accountName: 'PAYE Payable', debit: 0, credit: 20000, description: 'PAYE payable, net of ETI', inactiveAccount: false, cc1Id: null },
      { glAccountId: 'acc-2150', accountCode: '2150', accountName: 'UIF Payable', debit: 0, credit: 2000, description: 'UIF payable (employee + employer)', inactiveAccount: false, cc1Id: null },
      { glAccountId: 'acc-2160', accountCode: '2160', accountName: 'SDL Payable', debit: 0, credit: 1000, description: 'SDL payable', inactiveAccount: false, cc1Id: null },
      { glAccountId: 'acc-1110', accountCode: '1110', accountName: 'Bank - Primary', debit: 0, credit: 76000, description: 'Net pay — bank disbursement', inactiveAccount: false, cc1Id: null },
      { glAccountId: 'acc-2175', accountCode: '2175', accountName: 'Other Employee Deductions Payable', debit: 0, credit: 3000, description: 'Other employee deductions (medical aid, pension, RA, etc.)', inactiveAccount: false, cc1Id: null },
    ]);
  });
});

describe('payroll net pay — no usable bank role', () => {
  it('blocks, names the problem and never falls back to 1110, when no account holds the role', async () => {
    routeMock(UNMOVED); // an active 1110 exists but is not the role holder
    getSystemAccount.mockRejectedValue(new MissingSystemAccountError('bank', COMPANY, 'no_claimant', []));

    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    const blocker = plan!.blockers.find((b) => b.code === 'missing_bank_account');
    expect(blocker?.detail).toMatch(/bank/i);
    expect(blocker?.detail).toMatch(/Default Accounts/);
    const net = plan!.lines.find((l) => l.credit === 76000);
    expect(net).toMatchObject({ glAccountId: null, accountCode: '' });
    expect(plan!.lines.map((l) => l.glAccountId)).not.toContain('acc-1110');
  });

  it('does not block on the missing bank when net pay is zero: the net-pay line is dropped, no bank is credited', async () => {
    routeMock(UNMOVED, { ...HEADER, total_net: 0 });
    getSystemAccount.mockRejectedValue(new MissingSystemAccountError('bank', COMPANY, 'no_claimant', []));

    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(plan!.lines.some((l) => l.description === 'Net pay — bank disbursement')).toBe(false);
    expect(plan!.blockers.map((b) => b.code)).not.toContain('missing_bank_account');
    expect(plan!.blockers).toEqual([]);
  });

  it('names the deactivated candidates when only deactivated accounts claim the role', async () => {
    routeMock(MOVED);
    getSystemAccount.mockRejectedValue(new MissingSystemAccountError('bank', COMPANY, 'deactivated_claimants_only', [
      { id: 'acc-1110', accountCode: '1110', accountName: 'Bank - Primary', accountType: 'asset', accountSubtype: 'bank', createdAt: 0, isActive: false, isSystemAccount: true },
    ]));

    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    const blocker = plan!.blockers.find((b) => b.code === 'missing_bank_account');
    expect(blocker?.detail).toContain('1110');
    expect(blocker?.detail).toMatch(/deactivated/);
  });

  it('blocks as inactive_target_account when the holder was deactivated after the resolver cached it', async () => {
    routeMock([...PAYROLL_ACCOUNTS, bank('1544331', 'acc-bank', 'ABSA Cheque', { is_active: false })]);
    getSystemAccount.mockResolvedValue(holder('acc-bank', '1544331', 'ABSA Cheque'));

    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    const net = plan!.lines.find((l) => l.credit === 76000);
    expect(net).toMatchObject({ accountCode: '1544331', inactiveAccount: true });
    expect(plan!.blockers.find((b) => b.code === 'inactive_target_account')?.detail).toContain('1544331');
  });

  it('does not swallow a resolver failure that is not a missing role', async () => {
    routeMock(MOVED);
    getSystemAccount.mockRejectedValue(new Error('connection terminated'));
    await expect(buildPayrollJournalPlan(COMPANY, RUN)).rejects.toThrow('connection terminated');
  });

  it('the live poster refuses with the blocker and writes nothing', async () => {
    routeMock(UNMOVED);
    getSystemAccount.mockRejectedValue(new MissingSystemAccountError('bank', COMPANY, 'no_claimant', []));

    await expect(postPayrollRunJournal(COMPANY, RUN, 'user-1')).rejects.toThrow(/bank/i);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });
});

describe('payroll net pay — the holder is re-read, not trusted from the resolver cache', () => {
  const stale = () => getSystemAccount.mockResolvedValue(holder('acc-1110', '1110', 'Bank - Primary'));

  it('blocks when the role moved off the cached holder within the cache window, and posts nothing', async () => {
    // The resolver still answers 1110; the table now flags 1544331 and no longer flags 1110.
    routeMock([...PAYROLL_ACCOUNTS, bank('1110', 'acc-1110', 'Bank - Primary', { is_system_account: false }), bank('1544331', 'acc-bank', 'ABSA Cheque')]);
    stale();

    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    const blocker = plan!.blockers.find((b) => b.code === 'missing_bank_account');
    expect(blocker?.detail).toMatch(/1110 Bank - Primary no longer holds/);
    expect(plan!.lines.map((l) => l.glAccountId)).not.toContain('acc-1110');
    await expect(postPayrollRunJournal(COMPANY, RUN, 'user-1')).rejects.toThrow(/no longer holds/);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('blocks when the cached holder was deactivated and another account took the role', async () => {
    routeMock(MOVED);
    stale();
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers.map((b) => b.code)).toContain('missing_bank_account');
    expect(plan!.blockers.map((b) => b.code)).not.toContain('inactive_target_account');
  });

  it('blocks when the cached holder row is gone', async () => {
    routeMock(PAYROLL_ACCOUNTS);
    stale();
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers.find((b) => b.code === 'missing_bank_account')?.detail).toMatch(/no longer holds/);
  });
});

describe('payroll net pay — two accounts claim the bank role', () => {
  it('refuses, naming both, instead of taking the resolver\'s pick', async () => {
    routeMock([...UNMOVED, bank('1544331', 'acc-bank', 'ABSA Cheque')]);
    getSystemAccount.mockResolvedValue(holder('acc-bank', '1544331', 'ABSA Cheque'));

    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    const blocker = plan!.blockers.find((b) => b.code === 'ambiguous_bank_account');
    expect(blocker?.detail).toContain('1110 Bank - Primary');
    expect(blocker?.detail).toContain('1544331 ABSA Cheque');
    expect(plan!.lines.find((l) => l.credit === 76000)?.glAccountId).toBeNull();
    await expect(postPayrollRunJournal(COMPANY, RUN, 'user-1')).rejects.toThrow(/1110 Bank - Primary; 1544331 ABSA Cheque|1544331 ABSA Cheque; 1110 Bank - Primary/);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('does not count a deactivated or unflagged claimant', async () => {
    routeMock([...MOVED, bank('1200', 'acc-1200', 'Old unflagged', { is_system_account: false })]);
    getSystemAccount.mockResolvedValue(holder('acc-bank', '1544331', 'ABSA Cheque'));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers).toEqual([]);
  });
});

describe('payroll net pay — the holder must be postable', () => {
  const HDR = 'dddddddd-dddd-dddd-dddd-dddddddddddd'; // the guard judges UUID ids only
  it('blocks a holder that is a header with sub-accounts, as the poster would refuse it', async () => {
    routeMock([
      ...PAYROLL_ACCOUNTS,
      bank('1544331', HDR, 'ABSA Cheque', { level: 1 }),
      acc('1544331-1', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', 'ABSA sub', { parent_account_id: HDR, level: 2 }),
    ]);
    getSystemAccount.mockResolvedValue(holder(HDR, '1544331', 'ABSA Cheque'));

    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(plan!.blockers.find((b) => b.code === 'header_bank_account')?.detail).toMatch(/is a header with sub-accounts/);
    expect(plan!.lines.find((l) => l.credit === 76000)?.glAccountId).toBeNull();
    await expect(postPayrollRunJournal(COMPANY, RUN, 'user-1')).rejects.toThrow(/header/);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('blocks a holder that is not an asset, as a liability credit is no payment from the bank', async () => {
    routeMock([...PAYROLL_ACCOUNTS, bank('1544331', 'acc-bank', 'ABSA Cheque', { account_type: 'liability' })]);
    getSystemAccount.mockResolvedValue(holder('acc-bank', '1544331', 'ABSA Cheque'));

    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(plan!.blockers.find((b) => b.code === 'not_asset_bank_account')?.detail).toMatch(/is a liability account, not an asset/);
    expect(plan!.lines.find((l) => l.credit === 76000)?.glAccountId).toBeNull();
    await expect(postPayrollRunJournal(COMPANY, RUN, 'user-1')).rejects.toThrow(/not an asset/);
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('accepts a leaf holder that has a parent', async () => {
    routeMock([
      ...PAYROLL_ACCOUNTS,
      acc('1500', 'ffffffff-ffff-ffff-ffff-ffffffffffff', 'Bank accounts', { level: 2 }),
      bank('1544331', HDR, 'ABSA Cheque', { level: 3, parent_account_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }),
    ]);
    getSystemAccount.mockResolvedValue(holder(HDR, '1544331', 'ABSA Cheque'));
    expect((await buildPayrollJournalPlan(COMPANY, RUN))!.blockers).toEqual([]);
  });
});

describe('payroll net pay — negative_amount names a line with no account', () => {
  it('labels net pay by its description when no bank holder gives it a code', async () => {
    routeMock(UNMOVED, { ...HEADER, total_net: -500 });
    getSystemAccount.mockRejectedValue(new MissingSystemAccountError('bank', COMPANY, 'no_claimant', []));

    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    const negative = plan!.blockers.find((b) => b.code === 'negative_amount');
    expect(negative?.detail).toContain('Net pay — bank disbursement');
  });
});
