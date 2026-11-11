/**
 * The employer's medical scheme contribution (a NON-CASH 3810 earning, employerContributions.ts) in the payroll journal.
 * It is outside gross pay, but unlike the 3801 loan or 3802 vehicle benefit the employer really pays it to the scheme:
 * the journal debits it to labour (on the employee's own cost centre) and credits it to 2175 beside the 4005 deduction.
 * Before this, the run's journal carried only the employee's 4005 as scheme payable and booked the employer's share nowhere.
 * Same mocks and fixtures as payrollJournalBuilder-k079.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> = () => Promise.resolve([]);

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => mockImpl(strings, ...values),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/bankRoleHolder', () => ({
  resolveBankRoleHolder: vi.fn(async () => ({ account: { id: 'acc-1110', code: '1110', name: 'Bank - Primary', isActive: true }, refusal: null })),
}));
vi.mock('@/modules/accounting/services/payroll/costCentreGlMappingService', () => ({
  getMappingLookup: vi.fn(async () => ({})),
}));

import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { getMappingLookup } from '@/modules/accounting/services/payroll/costCentreGlMappingService';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

// A: R10 000 cash + R2 000 non-cash 3810 (employer's share), R500 4005 deducted; B: R10 000 cash.
// SDL 1% of remuneration: A R120, B R100. Net = 20 000 − 2 000 PAYE − 200 employee UIF − 500 (4005) = 17 300.
const HEADER = {
  id: RUN, company_id: COMPANY, period_month: 12, period_year: 2026, status: 'approved', journal_entry_id: null,
  total_gross: 20000, total_paye: 2000, total_uif: 400, total_sdl: 220, total_eti: 0, total_net: 17300, employee_count: 2,
};
const LINES = [
  { employee_id: 'A', gross_pay: 10000, eti: 0, sdl: 120, non_cash: 2000, cost_centre_id: 'X' },
  { employee_id: 'B', gross_pay: 10000, eti: 0, sdl: 100, non_cash: 0, cost_centre_id: 'Y' },
];
const ACCOUNTS = [
  { account_code: '5200', id: 'acc-5200', account_name: 'Labour Costs', is_active: true },
  { account_code: '2140', id: 'acc-2140', account_name: 'PAYE Payable', is_active: true },
  { account_code: '2150', id: 'acc-2150', account_name: 'UIF Payable', is_active: true },
  { account_code: '2160', id: 'acc-2160', account_name: 'SDL Payable', is_active: true },
  { account_code: '2175', id: 'acc-2175', account_name: 'Other Employee Deductions Payable', is_active: true },
];

function routes(opts: { header?: Record<string, unknown>; medical?: unknown[]; accounts?: unknown[] } = {}) {
  const table: Array<{ match: string; rows: unknown[] }> = [
    { match: 'payroll_employee_cost_allocations', rows: [] },
    { match: '3810', rows: opts.medical ?? [{ employee_id: 'A', employer_medical: '2000.00' }] },
    { match: 'payroll_run_lines prl', rows: LINES },
    { match: 'payroll_run_headers', rows: [opts.header ?? HEADER] },
    { match: 'FROM gl_accounts', rows: opts.accounts ?? ACCOUNTS },
  ];
  mockImpl = (strings) => {
    const q = strings.join('?');
    return Promise.resolve(table.find((r) => q.includes(r.match))?.rows ?? []);
  };
}

type Plan = NonNullable<Awaited<ReturnType<typeof buildPayrollJournalPlan>>>;
const on = (plan: Plan, code: string, side: 'debit' | 'credit') =>
  plan.lines.filter((l) => l.accountCode === code).reduce((s, l) => s + l[side], 0);

beforeEach(() => { mockImpl = () => Promise.resolve([]); });

describe('buildPayrollJournalPlan — employer medical contribution (non-cash 3810)', () => {
  it('debits it to labour and credits it to 2175 as scheme payable, and balances', async () => {
    routes();
    const plan = (await buildPayrollJournalPlan(COMPANY, RUN))!;

    expect(plan.blockers).toEqual([]);
    expect(on(plan, '5200', 'debit')).toBe(20000 + 200 + 220 + 2000);
    expect(on(plan, '2175', 'credit')).toBe(500 + 2000);
    expect(plan.totalDebit).toBe(22420);
    expect(plan.totalCredit).toBe(22420);
  });

  it('puts the contribution on the employee\'s own cost centre, not spread by gross', async () => {
    vi.mocked(getMappingLookup).mockResolvedValueOnce({ X: 'acc-5210', Y: 'acc-5220' });
    routes();
    const plan = (await buildPayrollJournalPlan(COMPANY, RUN))!;

    const debitOn = (id: string) => plan.lines.find((l) => l.glAccountId === id)?.debit;
    // Cost less SDL and medical (20 200) by gross share, plus each line's own SDL and medical.
    expect(debitOn('acc-5210')).toBe(10100 + 120 + 2000);
    expect(debitOn('acc-5220')).toBe(10100 + 100);
    expect(plan.totalDebit).toBe(plan.totalCredit);
  });

  it('needs 2175 even when the run has no other deductions', async () => {
    routes({ header: { ...HEADER, total_net: 17800 }, accounts: ACCOUNTS.filter((a) => a.account_code !== '2175') });
    const plan = (await buildPayrollJournalPlan(COMPANY, RUN))!;

    expect(plan.blockers.map((b) => b.code)).toContain('missing_other_deductions_account');
  });

  it('without a non-cash 3810, the journal is unchanged', async () => {
    routes({ medical: [], header: { ...HEADER, total_sdl: 200 } });
    const plan = (await buildPayrollJournalPlan(COMPANY, RUN))!;

    expect(on(plan, '5200', 'debit')).toBe(20000 + 200 + 200);
    expect(on(plan, '2175', 'credit')).toBe(500);
  });
});
