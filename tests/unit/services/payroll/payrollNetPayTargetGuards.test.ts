/**
 * The payroll plan's net-pay target: what the allow-list accepts (payroll_liability in any spelling the vocabulary
 * knows, no account a loan uses), a setting row that cannot be read (fail closed, `invalid_net_pay_setting`), the header
 * guard's rethrow, and a net-pay account that another line of the plan also uses (`net_pay_account_shared`).
 * Same fixture as payrollNetPayTarget.test.ts (tests/helpers/netPayPlanRig.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MissingSystemAccountError } from '@/modules/accounting/services/gl/systemAccountKeys';
import {
  C2170, COMPANY, HEADER, OTHER_2170, RUN, VELOCITY, PAYROLL_ACCOUNTS, bank, acc, liability, on, rig, routeMock, sqlStub, type GlAccountRow,
} from '../../../helpers/netPayPlanRig';

vi.mock('@/lib/neon', () => ({ sql: sqlStub, withTransaction: async (fn: (tx: typeof sqlStub) => Promise<unknown>) => fn(sqlStub) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
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
const createJournalEntry = vi.fn(async () => ({ id: 'je-1' }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({
  createJournalEntry: (...args: unknown[]) => (createJournalEntry as (...a: unknown[]) => unknown)(...args),
}));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({
  postJournalEntry: vi.fn(async () => undefined),
  reverseJournalEntry: vi.fn(),
}));

import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { postPayrollRunJournal } from '@/modules/accounting/services/payroll/payrollJournalPostingService';
import { NET_PAY_CLEARING_DESCRIPTION, NET_PAY_DESCRIPTION } from '@/modules/accounting/services/payroll/payrollLabourComparison';
import { sharedNetPayAccountBlocker, type NetPayTarget } from '@/modules/accounting/services/payroll/payrollJournalBank';
import type { PayrollJournalPlanLine } from '@/modules/accounting/services/payroll/payrollJournalBuilder';

const holder = () => getSystemAccount.mockResolvedValue({ id: 'acc-1110', accountCode: '1110', accountName: 'Bank - Primary' });
const noBank = () => getSystemAccount.mockRejectedValue(new MissingSystemAccountError('bank', COMPANY, 'no_claimant', []));
const netLines = (lines: Array<{ credit: number }>) => lines.filter((l) => l.credit === 76000);

beforeEach(() => {
  getSystemAccount.mockReset();
  createJournalEntry.mockClear();
  rig.impl = () => Promise.resolve([]);
  rig.loanAccounts = new Set();
});

describe('the allow-list: payroll_liability, in any spelling the vocabulary knows', () => {
  it('accepts payroll_liabilities (the plural alias) like payroll_liability', async () => {
    routeMock([...VELOCITY.filter((a) => a.account_code !== '2170'), liability('2170', C2170, 'Net Salaries Payable', { account_subtype: 'payroll_liabilities' })], on(C2170));
    noBank();
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers).toEqual([]);
    expect(netLines(plan!.lines)[0]).toMatchObject({ glAccountId: C2170 });
  });

  it('refuses an account a loan uses (loans.*_account_id) even on the payroll_liability subtype', async () => {
    routeMock(VELOCITY, on(C2170));
    rig.loanAccounts = new Set([C2170]);
    holder();
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers.map((b) => b.code)).toContain('loan_net_pay_account');
    expect(getSystemAccount).not.toHaveBeenCalled();
    expect(plan!.lines.some((l) => l.description === NET_PAY_DESCRIPTION)).toBe(false);
  });

  it('a loan of ANOTHER company on the same account id does not refuse this company', async () => {
    routeMock(VELOCITY, on(C2170));
    rig.loanAccounts = new Set(['some-other-account']);
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers.map((b) => b.code)).not.toContain('loan_net_pay_account');
  });
});

describe('a setting row that cannot be read fails closed (invalid_net_pay_setting), never the bank, never a throw', () => {
  it.each([
    ['text that is not JSON', 'not json'],
    ['a number', 42],
    ['a list', ['payroll_net_pay']],
    ['an object whose net pay is a number', { payroll_net_pay: 7 }],
    ['an object whose net pay is an object', { payroll_net_pay: { id: C2170 } }],
    ['JSON text of a list', JSON.stringify(['x'])],
    ['text encoded three times', JSON.stringify(JSON.stringify(JSON.stringify(on(C2170))))],
  ])('%s', async (_name, setting) => {
    routeMock(VELOCITY, setting);
    holder();
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    const blocker = plan!.blockers.find((b) => b.code === 'invalid_net_pay_setting');
    // Truthful: names the row, says the page cannot repair it (non-JSON text fails the page's GET; `{"payroll_net_pay":7}` or a list
    // read as empty there, so Save has nothing to change) and that support must, and does not send the user to the page.
    expect(blocker?.detail).toContain('accounting_default_accounts');
    expect(blocker?.detail).toMatch(/needs repair by support; payroll stays blocked until then/);
    expect(blocker?.detail).not.toMatch(/Save the Default Accounts page/);
    expect(getSystemAccount).not.toHaveBeenCalled();
    expect(plan!.lines.some((l) => l.description === NET_PAY_DESCRIPTION)).toBe(false);
    await expect(postPayrollRunJournal(COMPANY, RUN, 'user-1')).rejects.toThrow();
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('a string encoded twice is read through (it names 2170)', async () => {
    routeMock(VELOCITY, JSON.stringify(JSON.stringify(on(C2170))));
    noBank();
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers).toEqual([]);
    expect(netLines(plan!.lines)[0]).toMatchObject({ glAccountId: C2170 });
  });
});

describe('the header guard: only its own refusal is a blocker', () => {
  it('rethrows a rejected header-guard query instead of reporting a header or reading the bank', async () => {
    routeMock(VELOCITY, on(C2170));
    holder();
    const answer = rig.impl;
    rig.impl = (strings, ...values) => (strings.join('?').includes('parent_account_id')
      ? Promise.reject(new Error('header guard: connection terminated'))
      : answer(strings, ...values));
    await expect(buildPayrollJournalPlan(COMPANY, RUN)).rejects.toThrow('header guard: connection terminated');
    expect(getSystemAccount).not.toHaveBeenCalled();
  });
});

describe('a net-pay account that another line of the plan also uses is blocked (net_pay_account_shared)', () => {
  const line = (glAccountId: string | null, debit: number, credit: number, description: string): PayrollJournalPlanLine =>
    ({ glAccountId, accountCode: '', accountName: '', debit, credit, description, inactiveAccount: false, cc1Id: null });
  const target = (id: string | null, kind: 'bank' | 'clearing' = 'clearing'): NetPayTarget =>
    ({ kind, account: id ? { id, code: '2170', name: 'Net Salaries Payable', isActive: true } : null, blocker: null });
  const netLine = line(C2170, 0, 76000, NET_PAY_CLEARING_DESCRIPTION);

  it('labour debited to the net-pay account (a cost-centre mapping onto 2170) is named, by id', () => {
    const blocker = sharedNetPayAccountBlocker(target(C2170), [line(C2170, 76000, 0, 'Labour costs - gross pay'), line('acc-2140', 0, 24000, 'PAYE'), netLine]);
    expect(blocker?.code).toBe('net_pay_account_shared');
    expect(blocker?.detail).toContain('2170 Net Salaries Payable');
    expect(blocker?.detail).toContain('Labour costs - gross pay');
    expect(blocker?.detail).toMatch(/cost-centre GL mappings/);
  });

  it('a credit line of another purpose on the same id is shared too (not only labour debits)', () => {
    expect(sharedNetPayAccountBlocker(target(C2170), [line(C2170, 0, 100, 'PAYE payable'), netLine])?.code).toBe('net_pay_account_shared');
  });

  it('applies to a bank target as well: a bank role holder used as a labour account', () => {
    const bankLine = line('acc-1110', 0, 76000, NET_PAY_DESCRIPTION);
    expect(sharedNetPayAccountBlocker(target('acc-1110', 'bank'), [line('acc-1110', 76000, 0, 'Labour'), bankLine])?.code).toBe('net_pay_account_shared');
  });

  it('a net-pay account that stands alone, or has no account yet (the plan is blocked anyway), is not blocked', () => {
    expect(sharedNetPayAccountBlocker(target(C2170), [line('acc-5200', 76000, 0, 'Labour'), line('acc-2140', 0, 24000, 'PAYE'), netLine])).toBeNull();
    expect(sharedNetPayAccountBlocker(target(null), [line('acc-5200', 76000, 0, 'Labour'), line(null, 0, 76000, NET_PAY_CLEARING_DESCRIPTION)])).toBeNull();
  });
});
