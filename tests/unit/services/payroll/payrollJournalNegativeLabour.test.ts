/**
 * Wave 6 FQd, breaker #1622 L-H / L-I: a net-negative labour amount (an SDL refund larger than the run's cost) is a
 * CREDIT to 5200, a reduction of expense, never a refusal: on the cost-centre path (5200 resolves) and on the
 * single-line path (no 5200 account id resolves; the plan then also names the missing account).
 */
import { describe, expect, it, vi } from 'vitest';

let rows: Array<{ match: string; rows: unknown[] }> = [];
vi.mock('@/lib/neon', () => ({
  sql: Object.assign((strings: TemplateStringsArray) => {
    const q = strings.join('?');
    return Promise.resolve(rows.find((r) => q.includes(r.match))?.rows ?? []);
  }, { unsafe: (text: string) => ({ unsafe: text }) }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/bankRoleHolder', () => ({
  resolveBankRoleHolder: vi.fn(async () => ({ account: { id: 'acc-1110', code: '1110', name: 'Bank', isActive: true }, refusal: null })),
}));
vi.mock('@/modules/accounting/services/payroll/costCentreGlMappingService', () => ({ getMappingLookup: vi.fn(async () => ({})) }));

import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';

const HEADER = {
  id: 'run-1', company_id: 'co-1', period_month: 1, period_year: 2027, status: 'approved', journal_entry_id: null,
  total_gross: 0, total_paye: 0, total_uif: 0, total_sdl: -3, total_eti: 0, total_net: 0, employee_count: 3,
};
const ACCOUNTS = ['5200', '2140', '2150', '2160', '1110', '2175'].map((c) => ({ account_code: c, id: `acc-${c}`, account_name: c, is_active: true }));
const routes = (accounts: unknown[]) => [
  { match: 'payroll_run_headers', rows: [HEADER] },
  { match: 'FROM gl_accounts', rows: accounts },
];
const pairs = (lines: Array<{ accountCode: string; debit: number; credit: number }>, code: string) =>
  lines.filter((l) => l.accountCode === code).map((l) => [l.debit, l.credit]);

describe('a net-negative labour amount', () => {
  it('5200 resolves: credits 5200 by R3.00 and debits 2160 by R3.00, balanced, no negative-amount blocker', async () => {
    rows = routes(ACCOUNTS);
    const plan = (await buildPayrollJournalPlan('co-1', 'run-1'))!;
    expect(pairs(plan.lines, '5200')).toEqual([[0, 3]]);
    expect(pairs(plan.lines, '2160')).toEqual([[3, 0]]);
    expect(plan.totalDebit).toBe(plan.totalCredit);
    expect(plan.blockers.map((b) => b.code)).not.toContain('negative_amount');
  });

  it('no 5200 account id resolves (the single-line path): still a credit, and only the missing account blocks', async () => {
    rows = routes(ACCOUNTS.filter((a) => a.account_code !== '5200'));
    const plan = (await buildPayrollJournalPlan('co-1', 'run-1'))!;
    expect(pairs(plan.lines, '5200')).toEqual([[0, 3]]);
    expect(plan.blockers.map((b) => b.code)).toEqual(['missing_gl_accounts']);
  });
});
