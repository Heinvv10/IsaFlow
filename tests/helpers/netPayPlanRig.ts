/**
 * Fixture for the payroll net-pay plan tests (payrollNetPayTarget*.test.ts): a Velocity-shaped chart, another tenant's
 * look-alike accounts, and a `sql` stub that answers by reading the query text (see glAccountsTableMock). The test files
 * mock '@/lib/neon' with `sqlStub`, so `rig.impl` is the one place a test swaps an answer.
 */
import { answerHeaderGuard, glAccount, selectGlAccounts, type GlAccountRow } from './glAccountsTableMock';

export type { GlAccountRow };
export type SqlImpl = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export const rig: { impl: SqlImpl; loanAccounts: Set<string> } = { impl: () => Promise.resolve([]), loanAccounts: new Set<string>() };
export const sqlStub = (strings: TemplateStringsArray, ...values: unknown[]) => rig.impl(strings, ...values);

export const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
export const OTHER = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
export const RUN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
export const C2170 = '21700000-0000-4000-8000-000000000001';
export const OTHER_2170 = '21700000-0000-4000-8000-0000000000ff';

export const HEADER = {
  id: RUN, company_id: COMPANY, period_month: 10, period_year: 2026, status: 'approved',
  journal_entry_id: null, total_gross: 100000, total_paye: 20000, total_uif: 2000,
  total_sdl: 1000, total_eti: 0, total_net: 76000, employee_count: 4,
  // A pre-R-035 approved run (migration 951): clears the approval gate (assertPayRunApproved) without a plan hash.
  approval_grandfathered_at: '2026-10-01T00:00:00Z',
};

export const acc = (code: string, id: string, name: string, over: Partial<GlAccountRow> = {}, company = COMPANY): GlAccountRow =>
  glAccount({ id, company_id: company, account_code: code, account_name: name, ...over });
export const liability = (code: string, id: string, name: string, over: Partial<GlAccountRow> = {}) =>
  acc(code, id, name, { account_type: 'liability', account_subtype: 'payroll_liability', ...over });

export const PAYROLL_ACCOUNTS = [
  acc('5200', 'acc-5200', 'Labour Costs'),
  acc('2140', 'acc-2140', 'PAYE Payable'),
  acc('2150', 'acc-2150', 'UIF Payable'),
  acc('2160', 'acc-2160', 'SDL Payable'),
  acc('2175', 'acc-2175', 'Other Employee Deductions Payable'),
];
export const bank = acc('1110', 'acc-1110', 'Bank - Primary', { account_subtype: 'bank', is_system_account: true });
export const VELOCITY = [...PAYROLL_ACCOUNTS, bank, liability('2170', C2170, 'Net Salaries Payable')];
/** Another tenant, in the same table: a query that drops its company filter finds these. */
export const OTHER_TENANT = [liability('2170', OTHER_2170, 'Their Net Salaries Payable', {}), acc('1110', 'other-bank', 'Other Bank', { account_subtype: 'bank', is_system_account: true })]
  .map((a) => ({ ...a, company_id: OTHER }));

/** The accounts a loan of the company points at (loans.*_account_id), for the loan-account refusal. */


/** `setting` is what app_settings holds for accounting_default_accounts (undefined = no row). */
export function routeMock(accounts: GlAccountRow[], setting: unknown, header: Record<string, unknown> = HEADER) {
  const table = [...accounts, ...OTHER_TENANT];
  rig.impl = (strings, ...values) => {
    const q = strings.join('?');
    if (q.includes('payroll_run_headers')) {
      return Promise.resolve(values.includes(RUN) && values.includes(COMPANY) ? [header] : []);
    }
    if (q.includes('app_settings')) {
      const scoped = values.includes(COMPANY) && values.includes('accounting_default_accounts');
      return Promise.resolve(scoped && setting !== undefined ? [{ value: setting }] : []);
    }
    if (q.includes('FROM loans')) {
      return Promise.resolve(values.includes(COMPANY) && values.some((v) => rig.loanAccounts.has(String(v))) ? [{ '?column?': 1 }] : []);
    }
    if (q.includes('parent_account_id')) return Promise.resolve(answerHeaderGuard(table, strings, values));
    if (q.includes('FROM gl_accounts')) return Promise.resolve(selectGlAccounts(table, strings, values));
    return Promise.resolve([]);
  };
}
export const on = (id: string | null) => ({ payroll_net_pay: id, sales_discount: 'unrelated' });
