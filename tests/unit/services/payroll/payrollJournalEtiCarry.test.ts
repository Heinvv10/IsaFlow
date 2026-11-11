/**
 * ET (wave 5): the payroll journal books the ETI brought forward that the EMP201 uses, so the run's 2140 credit stays
 * the EMP201 PAYE payable (K-079). ETI Act s9(1) and s10(3); SARS Guide to the Employment Tax Incentive, Issue 5, §7-§8.
 * Same mocks as payrollJournalBuilder-k079.test.ts; both readers are fed the same stored headers.
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
vi.mock('@/modules/accounting/services/payroll/costCentreGlMappingService', () => ({ getMappingLookup: vi.fn(async () => ({})) }));

import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const RUN = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

/** June 2026: PAYE R3 000, ETI R500. */
const JUNE = {
  id: RUN, company_id: COMPANY, period_month: 6, period_year: 2026, status: 'approved', journal_entry_id: null,
  total_gross: 40_000, total_paye: 3_000, total_uif: 800, total_sdl: 400, total_eti: 500, total_net: 36_600,
  employee_count: 3, non_cash: 0, employee_ids: ['e1', 'e2', 'e3'],
};
const ACCOUNTS = ['5200', '2140', '2150', '2160', '1110', '2175'].map((code) => ({
  account_code: code, id: `acc-${code}`, account_name: code, is_active: true,
}));

/** The earlier months of the March-August period, as the carry reads them. */
function route(earlier: unknown[]) {
  mockImpl = (strings) => {
    const q = strings.join('?');
    if (q.includes('information_schema.tables')) return Promise.resolve([{ table_name: 'payroll_run_headers' }, { table_name: 'payroll_run_lines' }]);
    if (q.includes('GROUP BY period_year, period_month')) return Promise.resolve(earlier);
    if (q.includes('payroll_run_headers')) return Promise.resolve([JUNE]);
    if (q.includes('FROM gl_accounts')) return Promise.resolve(ACCOUNTS);
    return Promise.resolve([]);
  };
}

const credit = (plan: Awaited<ReturnType<typeof buildPayrollJournalPlan>>, code: string) =>
  plan!.lines.filter((l) => l.accountCode === code).reduce((s, l) => s + l.credit, 0);
const debit = (plan: Awaited<ReturnType<typeof buildPayrollJournalPlan>>, code: string) =>
  plan!.lines.filter((l) => l.accountCode === code).reduce((s, l) => s + l.debit, 0);

beforeEach(() => { mockImpl = () => Promise.resolve([]); });

describe('the journal books the ETI brought forward, as the EMP201 uses it', () => {
  it('May left R1 800: June books R2 300 of ETI, and CR 2140 = the EMP201 PAYE payable = R700', async () => {
    route([{ period_year: 2026, period_month: 4, paye: 1_000, eti: 1_000 }, { period_year: 2026, period_month: 5, paye: 200, eti: 2_000 }]);
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    const emp201 = await generateEMP201(COMPANY, '2026-06-01', '2026-06-30');

    expect(emp201.etiCarry.broughtForward).toBe(1_800);
    expect(emp201.payePayable).toBe(700);
    expect(credit(plan, '2140')).toBe(emp201.payePayable);
    expect(plan!.totals.etiUsed).toBe(2_300);
    expect(debit(plan, '5200')).toBe(40_000 + 400 + 400 - 2_300);
    expect(plan!.totalDebit).toBe(plan!.totalCredit);
    expect(plan!.advisories.map((a) => a.code)).toContain('eti_brought_forward');
  });

  it('brought forward above PAYE: books only PAYE, drops the 2140 line, and the rest is carried (still equal to the EMP201)', async () => {
    route([{ period_year: 2026, period_month: 5, paye: 0, eti: 4_000 }]);
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    const emp201 = await generateEMP201(COMPANY, '2026-06-01', '2026-06-30');

    expect(emp201.payePayable).toBe(0);
    expect(credit(plan, '2140')).toBe(0);
    expect(plan!.totals.etiUsed).toBe(3_000);
    expect(emp201.etiCarry.carriedForward).toBe(1_500);
    expect(plan!.advisories.find((a) => a.code === 'eti_beyond_paye')?.detail).toContain('R1500.00');
  });

  it('nothing brought forward into March: February\'s excess is a refund, not booked in March (s10(3))', async () => {
    route([{ period_year: 2026, period_month: 2, paye: 0, eti: 4_000 }]);
    mockImpl = ((inner) => (strings: TemplateStringsArray, ...v: unknown[]) => {
      const q = strings.join('?');
      if (q.includes('payroll_run_headers') && !q.includes('GROUP BY')) return Promise.resolve([{ ...JUNE, period_month: 3 }]);
      return inner(strings, ...v);
    })(mockImpl);
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.totals.etiUsed).toBe(500);
    expect(credit(plan, '2140')).toBe(2_500);
  });
});
