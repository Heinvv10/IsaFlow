/**
 * The payroll journal PLAN carries each labour line's CC1, and the poster hands
 * it to the GL (Hein, 2026-11-02: "post with CC1"). A centre the GL refuses as
 * a new CC1 tag — inactive, or a CC2 — posts untagged on the same account with
 * a `labour_cost_centre_untagged` advisory: a dimension tag never blocks payroll.
 * Same sql route-mock as payrollJournalBuilder.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let mockImpl: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]> = () => Promise.resolve([]);
const sqlCalls: Array<{ sql: string; values: unknown[] }> = [];

vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ sql: strings.join('?'), values });
    return mockImpl(strings, ...values);
  },
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
// The bank role's holder is this chart's 1110 (the resolver itself is tested in payrollJournalBankRole.test.ts).
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn(async () => ({ id: 'acc-1110', accountCode: '1110', accountName: 'Bank - Primary' })),
}));
vi.mock('@/modules/accounting/services/payroll/costCentreGlMappingService', () => ({ getMappingLookup: vi.fn(async () => ({})) }));
vi.mock('@/modules/accounting/services/gl/journalEntryCrudService', () => ({ createJournalEntry: vi.fn(async () => ({ id: 'je-1' })) }));
vi.mock('@/modules/accounting/services/gl/journalEntryPostingService', () => ({ postJournalEntry: vi.fn(), reverseJournalEntry: vi.fn() }));

import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { postPayrollRunJournal } from '@/modules/accounting/services/payroll/payrollJournalPostingService';
import { getMappingLookup } from '@/modules/accounting/services/payroll/costCentreGlMappingService';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const HEADER = {
  id: RUN, company_id: COMPANY, period_month: 12, period_year: 2026, status: 'approved', journal_entry_id: null,
  total_gross: 40000, total_paye: 8000, total_uif: 800, total_sdl: 400, total_eti: 0, total_net: 31600, employee_count: 3,
};
const ACCOUNTS = ['5200', '2140', '2150', '2160', '1110'].map((code) => ({ account_code: code, id: `acc-${code}`, account_name: code, is_active: true }));
const CENTRES = [
  { id: 'cc-a', code: 'A', cc_type: 'cc1', is_active: true },
  { id: 'cc-b', code: 'B', cc_type: 'cc1', is_active: true },
  { id: 'cc-old', code: 'OLD', cc_type: 'cc1', is_active: false },
  { id: 'cc-proj', code: 'PRJ', cc_type: 'cc2', is_active: true },
];

function route(lines: unknown[], allocations: unknown[] = []) {
  const routes: Array<{ match: string; rows: unknown[] }> = [
    { match: 'payroll_run_headers', rows: [HEADER] },
    { match: 'payroll_employee_cost_allocations', rows: allocations },
    { match: 'payroll_run_lines prl', rows: lines },
    { match: 'FROM cost_centres cc', rows: CENTRES },
    { match: 'id = ANY', rows: [{ id: 'acc-5210', account_code: '5210', account_name: 'Site labour', is_active: true }, { id: 'acc-1110', account_code: '1110', account_name: 'Bank - Primary', is_active: true }] },
    { match: 'FROM gl_accounts', rows: ACCOUNTS },
  ];
  mockImpl = (strings) => Promise.resolve(routes.find((r) => strings.join('?').includes(r.match))?.rows ?? []);
}
const labour = (plan: Awaited<ReturnType<typeof buildPayrollJournalPlan>>) =>
  plan!.lines.filter((l) => l.debit > 0).map((l) => [l.accountCode, l.cc1Id, l.debit]);

beforeEach(() => { sqlCalls.length = 0; vi.mocked(createJournalEntry).mockClear(); });

describe('payroll journal plan — CC1 on the labour lines', () => {
  it('tags each labour line with its centre, two centres on one account giving two lines; credits carry none', async () => {
    vi.mocked(getMappingLookup).mockResolvedValueOnce({ 'cc-a': 'acc-5210', 'cc-b': 'acc-5210' });
    route([
      { employee_id: 'e1', gross_pay: 20000, eti: 0, cost_centre_id: 'cc-a' },
      { employee_id: 'e2', gross_pay: 10000, eti: 0, cost_centre_id: 'cc-b' },
      { employee_id: 'e3', gross_pay: 10000, eti: 0, cost_centre_id: null },
    ]);
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    // Labour 40 800 (gross + employer UIF 400 + SDL 400) by gross share.
    expect(labour(plan)).toEqual([['5210', 'cc-a', 20400], ['5210', 'cc-b', 10200], ['5200', null, 10200]]);
    expect(plan!.lines.filter((l) => l.credit > 0).every((l) => l.cc1Id === null)).toBe(true);
    expect(plan!.blockers).toEqual([]);
    expect(plan!.advisories.map((a) => a.code)).not.toContain('labour_cost_centre_untagged');
    const read = sqlCalls.find((c) => c.sql.includes('FROM cost_centres cc'));
    expect(read!.values).toContain(COMPANY);
  });

  it('an inactive centre and a CC2 post untagged on the account their mapping picks, with an advisory naming both', async () => {
    vi.mocked(getMappingLookup).mockResolvedValueOnce({ 'cc-old': 'acc-5210' });
    route([
      { employee_id: 'e1', gross_pay: 20000, eti: 0, cost_centre_id: 'cc-old' },
      { employee_id: 'e2', gross_pay: 10000, eti: 0, cost_centre_id: 'cc-a' },
      { employee_id: 'e3', gross_pay: 10000, eti: 0, cost_centre_id: null },
    ], [{ employee_id: 'e3', cost_centre_id: 'cc-proj', percentage: 100 }]);
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);

    expect(labour(plan)).toEqual([['5210', null, 20400], ['5200', 'cc-a', 10200], ['5200', null, 10200]]);
    expect(plan!.blockers).toEqual([]);
    const advisory = plan!.advisories.find((a) => a.code === 'labour_cost_centre_untagged');
    expect(advisory?.detail).toContain('OLD (inactive)');
    expect(advisory?.detail).toContain('PRJ (a CC2, not a CC1)');
    expect(advisory?.detail).not.toContain('A (');
  });

  it('the poster hands each line\'s CC1 to the GL', async () => {
    vi.mocked(getMappingLookup).mockResolvedValueOnce({ 'cc-a': 'acc-5210' });
    route([
      { employee_id: 'e1', gross_pay: 30000, eti: 0, cost_centre_id: 'cc-a' },
      { employee_id: 'e2', gross_pay: 10000, eti: 0, cost_centre_id: null },
    ]);
    await postPayrollRunJournal(COMPANY, RUN, 'u1');

    const input = vi.mocked(createJournalEntry).mock.calls[0]![1];
    expect(input.lines.filter((l) => l.debit > 0).map((l) => [l.glAccountId, l.cc1Id])).toEqual([['acc-5210', 'cc-a'], ['acc-5200', undefined]]);
    expect(input.lines.filter((l) => l.credit > 0).every((l) => !('cc1Id' in l))).toBe(true);
  });
});
