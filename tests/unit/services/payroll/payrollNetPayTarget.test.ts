/**
 * Net pay credits a clearing liability (e.g. 2170 Net Salaries Payable) when
 * the company's `payroll_net_pay` Default Accounts setting names one, and the
 * bank-role holder when it does not.
 *
 * Velocity Fibre pays salaries by bank lines allocated DR 2170 / CR bank (47 in
 * October, R803,850). A pay run that credited the bank as well would count net
 * pay twice. In clearing mode the bank role is not consulted at all, and an
 * unusable clearing account BLOCKS the plan: it never falls back to the bank,
 * which would reintroduce the double count with no sign of it.
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

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const OTHER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const RUN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const C2170 = '21700000-0000-4000-8000-000000000001';
const OTHER_2170 = '21700000-0000-4000-8000-0000000000ff';

const HEADER = {
  id: RUN, company_id: COMPANY, period_month: 10, period_year: 2026, status: 'approved',
  journal_entry_id: null, total_gross: 100000, total_paye: 20000, total_uif: 2000,
  total_sdl: 1000, total_eti: 0, total_net: 76000, employee_count: 4,
  // A pre-R-035 approved run (migration 951): clears the approval gate (assertPayRunApproved) without a plan hash.
  approval_grandfathered_at: '2026-10-01T00:00:00Z',
};

const acc = (code: string, id: string, name: string, over: Partial<GlAccountRow> = {}, company = COMPANY): GlAccountRow =>
  glAccount({ id, company_id: company, account_code: code, account_name: name, ...over });
const liability = (code: string, id: string, name: string, over: Partial<GlAccountRow> = {}) =>
  acc(code, id, name, { account_type: 'liability', account_subtype: 'payroll_liability', ...over });

const PAYROLL_ACCOUNTS = [
  acc('5200', 'acc-5200', 'Labour Costs'),
  acc('2140', 'acc-2140', 'PAYE Payable'),
  acc('2150', 'acc-2150', 'UIF Payable'),
  acc('2160', 'acc-2160', 'SDL Payable'),
  acc('2175', 'acc-2175', 'Other Employee Deductions Payable'),
];
const bank = acc('1110', 'acc-1110', 'Bank - Primary', { account_subtype: 'bank', is_system_account: true });
const VELOCITY = [...PAYROLL_ACCOUNTS, bank, liability('2170', C2170, 'Net Salaries Payable')];
/** Another tenant, in the same table: a query that drops its company filter finds these. */
const OTHER_TENANT = [liability('2170', OTHER_2170, 'Their Net Salaries Payable', {}), acc('1110', 'other-bank', 'Other Bank', { account_subtype: 'bank', is_system_account: true })]
  .map((a) => ({ ...a, company_id: OTHER }));

/** The accounts a loan of the company points at (loans.*_account_id), for the loan-account refusal. */
let loanAccounts = new Set<string>();

/** `setting` is what app_settings holds for accounting_default_accounts (undefined = no row). */
function routeMock(accounts: GlAccountRow[], setting: unknown, header: Record<string, unknown> = HEADER) {
  const table = [...accounts, ...OTHER_TENANT];
  mockImpl = (strings, ...values) => {
    const q = strings.join('?');
    if (q.includes('payroll_run_headers')) {
      return Promise.resolve(values.includes(RUN) && values.includes(COMPANY) ? [header] : []);
    }
    if (q.includes('app_settings')) {
      const scoped = values.includes(COMPANY) && values.includes('accounting_default_accounts');
      return Promise.resolve(scoped && setting !== undefined ? [{ value: setting }] : []);
    }
    if (q.includes('FROM loans')) {
      return Promise.resolve(values.includes(COMPANY) && values.some((v) => loanAccounts.has(String(v))) ? [{ '?column?': 1 }] : []);
    }
    if (q.includes('parent_account_id')) return Promise.resolve(answerHeaderGuard(table, strings, values));
    if (q.includes('FROM gl_accounts')) return Promise.resolve(selectGlAccounts(table, strings, values));
    return Promise.resolve([]);
  };
}
const on = (id: string | null) => ({ payroll_net_pay: id, sales_discount: 'unrelated' });
const holder = () => getSystemAccount.mockResolvedValue({ id: 'acc-1110', accountCode: '1110', accountName: 'Bank - Primary' });
const noBank = () => getSystemAccount.mockRejectedValue(new MissingSystemAccountError('bank', COMPANY, 'no_claimant', []));
const netLines = (lines: Array<{ credit: number }>) => lines.filter((l) => l.credit === 76000);

beforeEach(() => {
  getSystemAccount.mockReset();
  createJournalEntry.mockClear();
  loanAccounts = new Set();
  mockImpl = () => Promise.resolve([]);
});

describe('payroll net pay -> clearing account (setting on)', () => {
  it('credits 2170 with net, writes no bank line, and balances', async () => {
    routeMock(VELOCITY, on(C2170));
    holder();

    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(plan!.blockers).toEqual([]);
    const net = netLines(plan!.lines);
    expect(net).toHaveLength(1);
    expect(net[0]).toMatchObject({
      glAccountId: C2170, accountCode: '2170', accountName: 'Net Salaries Payable',
      debit: 0, credit: 76000, description: NET_PAY_CLEARING_DESCRIPTION, inactiveAccount: false,
    });
    expect(plan!.lines.map((l) => l.accountCode)).not.toContain('1110');
    expect(plan!.lines.some((l) => l.description === NET_PAY_DESCRIPTION)).toBe(false);
    expect(plan!.lines.map((l) => l.accountCode)).toEqual(['5200', '2140', '2150', '2160', '2170', '2175']);
    expect(plan!.totalDebit).toBeCloseTo(plan!.totalCredit, 2);
  });

  it('the clearing line does NOT reuse the bank description (the gate would fold them into one key)', async () => {
    routeMock(VELOCITY, on(C2170));
    holder();
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    const net = netLines(plan!.lines)[0] as { description: string };
    expect(net.description).not.toBe(NET_PAY_DESCRIPTION);
    expect(net.description).toBe('Net pay — net salaries payable');
  });

  it('does not consult the bank role at all: a company with no bank holder can still post', async () => {
    routeMock(VELOCITY, on(C2170));
    noBank();

    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(getSystemAccount).not.toHaveBeenCalled();
    expect(plan!.blockers).toEqual([]);
    expect(plan!.blockers.map((b) => b.code)).not.toContain('missing_bank_account');
    await postPayrollRunJournal(COMPANY, RUN, 'user-1');
    const input = (createJournalEntry.mock.calls[0] as unknown as [string, { lines: Array<{ glAccountId: string; credit: number; description: string }> }])[1];
    expect(netLines(input.lines).map((l) => [l.glAccountId, l.description])).toEqual([[C2170, NET_PAY_CLEARING_DESCRIPTION]]);
  });

  it('accepts the setting stored as a JSON string, as plainMapping does', async () => {
    routeMock(VELOCITY, JSON.stringify(on(C2170)));
    noBank();
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(netLines(plan!.lines)[0]).toMatchObject({ glAccountId: C2170 });
  });
});

describe('payroll net pay -> bank (setting absent)', () => {
  it.each([
    ['no app_settings row', undefined],
    ['a row without the key', { sales_discount: 'x' }],
    ['null', on(null)],
    ['an empty string', { payroll_net_pay: '' }],
  ])('%s: credits the bank role holder, as before', async (_name, setting) => {
    routeMock(VELOCITY, setting);
    holder();

    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(getSystemAccount).toHaveBeenCalledWith('bank', COMPANY);
    expect(plan!.blockers).toEqual([]);
    expect(netLines(plan!.lines)[0]).toMatchObject({ accountCode: '1110', description: NET_PAY_DESCRIPTION });
    expect(plan!.lines.map((l) => l.accountCode)).not.toContain('2170');
  });

  it('still blocks on a missing bank holder', async () => {
    routeMock(VELOCITY, undefined);
    noBank();
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers.map((b) => b.code)).toContain('missing_bank_account');
  });
});

describe('payroll net pay -> clearing account that fails the rules: blocked, NEVER the bank', () => {
  const HDR = '21700000-0000-4000-8000-0000000000aa';
  const KID = '21700000-0000-4000-8000-0000000000ab';
  const cases: Array<[string, GlAccountRow[], string, string]> = [
    ['a dangling id (the account was deleted)', VELOCITY, on('21700000-0000-4000-8000-0000000000de'), 'missing_net_pay_account'],
    ['a value that is not an id at all', VELOCITY, on('not-a-uuid'), 'missing_net_pay_account'],
    ['another company\'s account', VELOCITY, on(OTHER_2170), 'missing_net_pay_account'],
    ['an asset', [...VELOCITY, acc('1999', '21700000-0000-4000-8000-0000000000ac', 'Cash')], on('21700000-0000-4000-8000-0000000000ac'), 'not_liability_net_pay_account'],
    ['a header with sub-accounts', [...VELOCITY, liability('2200', HDR, 'Payables', { level: 1 }), liability('2210', KID, 'Sub', { parent_account_id: HDR, level: 2 })], on(HDR), 'header_net_pay_account'],
    ['2140, which the journal already credits for PAYE', VELOCITY.map((a) => (a.account_code === '2140' ? { ...a, id: '21700000-0000-4000-8000-000000002140', account_type: 'liability', account_subtype: 'payroll_liability' } : a)), on('21700000-0000-4000-8000-000000002140'), 'net_pay_account_conflict'],
    ['an account on a system-role subtype', [...VELOCITY, acc('2110', '21700000-0000-4000-8000-0000000000ad', 'Accounts Payable', { account_type: 'liability', account_subtype: 'payable', is_system_account: true })], on('21700000-0000-4000-8000-0000000000ad'), 'not_payroll_liability_net_pay_account'],
    ...[
      ['tax (the VAT201 reads every tax line)', 'tax'], ['no subtype', null], ['accounts_payable (AP control spelling)', 'accounts_payable'],
      ['creditors (AP control spelling)', 'creditors'], ['bank_account', 'bank_account'], ['credit_card', 'credit_card'],
      ['current_liability (current portion of loans)', 'current_liability'], ['long_term_liability', 'long_term_liability'],
      ['other_current_liability', 'other_current_liability'],
    ].map(([name, subtype]): [string, GlAccountRow[], string, string] => [
      `a liability with the subtype ${name}`,
      [...VELOCITY, liability('2125', '21700000-0000-4000-8000-0000000000ae', 'Other liability', { account_subtype: subtype })],
      on('21700000-0000-4000-8000-0000000000ae'), 'not_payroll_liability_net_pay_account',
    ]),
  ];

  it.each(cases)('%s', async (_name, accounts, setting, code) => {
    routeMock(accounts, setting);
    holder(); // a perfectly good bank is available, and must not be used

    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(plan!.blockers.map((b) => b.code)).toContain(code);
    expect(getSystemAccount).not.toHaveBeenCalled();
    expect(plan!.lines.map((l) => l.accountCode)).not.toContain('1110');
    expect(plan!.lines.some((l) => l.description === NET_PAY_DESCRIPTION)).toBe(false);
    await expect(postPayrollRunJournal(COMPANY, RUN, 'user-1')).rejects.toThrow();
    expect(createJournalEntry).not.toHaveBeenCalled();
  });

  it('the dangling-id blocker says what to do', async () => {
    routeMock(VELOCITY, on('21700000-0000-4000-8000-0000000000de'));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    const blocker = plan!.blockers.find((b) => b.code === 'missing_net_pay_account');
    expect(blocker?.detail).toMatch(/Default Accounts/);
    expect(plan!.lines.find((l) => l.credit === 76000)).toMatchObject({ glAccountId: null, description: NET_PAY_CLEARING_DESCRIPTION });
  });

  it('does not block a run that pays no one: the zero net-pay line is dropped', async () => {
    routeMock(VELOCITY, on('21700000-0000-4000-8000-0000000000de'), { ...HEADER, total_net: 0 });
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers.map((b) => b.code)).not.toContain('missing_net_pay_account');
  });

  it('a deactivated 2170 is the ordinary inactive_target_account blocker', async () => {
    routeMock([...PAYROLL_ACCOUNTS, bank, liability('2170', C2170, 'Net Salaries Payable', { is_active: false })], on(C2170));
    holder();

    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(netLines(plan!.lines)[0]).toMatchObject({ accountCode: '2170', inactiveAccount: true });
    expect(plan!.blockers.find((b) => b.code === 'inactive_target_account')?.detail).toContain('2170');
    expect(getSystemAccount).not.toHaveBeenCalled();
  });

  it('does not swallow a failure that is not a business refusal', async () => {
    routeMock(VELOCITY, on(C2170));
    holder();
    const answer = mockImpl;
    mockImpl = (strings, ...values) => (strings.join('?').includes('app_settings')
      ? Promise.reject(new Error('connection terminated'))
      : answer(strings, ...values));
    await expect(buildPayrollJournalPlan(COMPANY, RUN)).rejects.toThrow('connection terminated');
  });
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
    loanAccounts = new Set([C2170]);
    holder();
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers.map((b) => b.code)).toContain('loan_net_pay_account');
    expect(getSystemAccount).not.toHaveBeenCalled();
    expect(plan!.lines.some((l) => l.description === NET_PAY_DESCRIPTION)).toBe(false);
  });

  it('a loan of ANOTHER company on the same account id does not refuse this company', async () => {
    routeMock(VELOCITY, on(C2170));
    loanAccounts = new Set(['some-other-account']);
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
    expect(blocker?.detail).toMatch(/Default Accounts/);
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
    const answer = mockImpl;
    mockImpl = (strings, ...values) => (strings.join('?').includes('parent_account_id')
      ? Promise.reject(new Error('header guard: connection terminated'))
      : answer(strings, ...values));
    await expect(buildPayrollJournalPlan(COMPANY, RUN)).rejects.toThrow('header guard: connection terminated');
    expect(getSystemAccount).not.toHaveBeenCalled();
  });
});
