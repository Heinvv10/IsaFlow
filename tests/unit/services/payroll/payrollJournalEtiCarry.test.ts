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

import { formatMoney } from '@/lib/money/formatMoney';
import { buildPayrollJournalPlan } from '@/modules/accounting/services/payroll/payrollJournalBuilder';
import { generateEMP201 } from '@/modules/accounting/services/reports/emp201Service';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';

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

/** A stand-alone directive payment row as tax_directive_payments is read (directivePaymentFiling). */
const directive = (date: string, paye: number) => ({
  payment_id: `p-${date}`, gross_amount: paye * 3, paye_amount: paye, entry_date: date, directive_id: 'd1', directive_number: 'D1',
  directive_type: 'severance', employee_name: 'X', effective_date: date, issued_date: date, employee_id: 'e1', journal_id: 'j1', reversed_at: null,
});

/** The earlier months of the March-August period, as the carry reads them; directives by the bounds asked for. */
const REFUND_ACCOUNT = { id: 'acc-1150', account_code: '1150', account_name: 'ETI refund receivable (SARS)', account_type: 'asset', account_subtype: 'eti_refund_receivable', created_at: new Date(0) };
let systemAccounts: unknown[] = [REFUND_ACCOUNT];
let etiJournalsBooked: unknown[] = [];

function route(earlier: unknown[], directives: (start: unknown) => unknown[] = () => []) {
  mockImpl = (strings, ...values) => {
    const q = strings.join('?');
    if (q.includes('is_system_account = true')) return Promise.resolve(systemAccounts);
    if (q.includes('je.reference')) return Promise.resolve(etiJournalsBooked);
    if (q.includes('information_schema.tables')) return Promise.resolve([{ table_name: 'payroll_run_headers' }, { table_name: 'payroll_run_lines' }]);
    if (q.includes('tax_directive_payments')) return Promise.resolve(directives(values[1]));
    if (q.includes('total_paye AS paye')) return Promise.resolve((earlier as Array<Record<string, unknown>>).map((r) => ({ status: 'approved', ...r })));
    if (q.includes('payroll_run_headers')) return Promise.resolve([JUNE]);
    if (q.includes('FROM gl_accounts')) return Promise.resolve(ACCOUNTS);
    return Promise.resolve([]);
  };
}

const credit = (plan: Awaited<ReturnType<typeof buildPayrollJournalPlan>>, code: string) =>
  plan!.lines.filter((l) => l.accountCode === code).reduce((s, l) => s + l.credit, 0);
const debit = (plan: Awaited<ReturnType<typeof buildPayrollJournalPlan>>, code: string) =>
  plan!.lines.filter((l) => l.accountCode === code).reduce((s, l) => s + l.debit, 0);

beforeEach(() => {
  mockImpl = () => Promise.resolve([]);
  systemAccounts = [REFUND_ACCOUNT];
  etiJournalsBooked = [];
  clearSystemAccountCache();
});

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
    expect(plan!.advisories.find((a) => a.code === 'eti_beyond_paye')?.detail).toContain(formatMoney(1500));
  });

  it('ledger-breaker A: a directive\'s PAYE in the same month is absorbed too, so the month\'s 2140 nets to the EMP201 payable', async () => {
    // May ETI 2 000 / PAYE 200 (R1 800 carried); June run PAYE 3 000 ETI 500 + a June directive with PAYE R2 000.
    route([{ period_year: 2026, period_month: 5, paye: 200, eti: 2_000 }], (start) => (start === '2026-06-01' ? [directive('2026-06-15', 2_000)] : []));
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    const emp201 = await generateEMP201(COMPANY, '2026-06-01', '2026-06-30');
    // available 2 300 against PAYE 5 000: all used; payable 2 700. The run's 2140 = 3 000 - 2 300; the directive journal credits 2 000.
    expect(emp201.payePayable).toBe(2_700);
    expect(plan!.totals.etiUsed).toBe(2_300);
    expect(credit(plan, '2140') - debit(plan, '2140') + 2_000).toBe(emp201.payePayable);
    expect(plan!.totalDebit).toBe(plan!.totalCredit);
  });

  it('ledger-breaker A (coordinator repro): run PAYE 1 000 ETI 500, R1 800 carried, directive PAYE 2 000: the month nets to R700', async () => {
    route([{ period_year: 2026, period_month: 5, paye: 200, eti: 2_000 }], (start) => (start === '2026-06-01' ? [directive('2026-06-15', 2_000)] : []));
    const jun = { ...JUNE, total_paye: 1_000, total_net: 38_600 };
    mockImpl = ((inner) => (strings: TemplateStringsArray, ...v: unknown[]) => {
      const q = strings.join('?');
      if (q.includes('payroll_run_headers') && !q.includes('total_paye AS paye') && !q.includes('information_schema')) return Promise.resolve([jun]);
      return inner(strings, ...v);
    })(mockImpl);
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    const emp201 = await generateEMP201(COMPANY, '2026-06-01', '2026-06-30');
    expect(emp201.payePayable).toBe(700);
    // ETI used 2 300 > the run's PAYE 1 000: the run's 2140 line is a R1 300 debit against the directive's R2 000 credit.
    expect(debit(plan, '2140')).toBe(1_300);
    expect(credit(plan, '2140') - debit(plan, '2140') + 2_000).toBe(700);
    expect(plan!.totalDebit).toBe(plan!.totalCredit);
  });

  it('R-C: August books the period\'s unused ETI as a refund: DR ETI refund receivable / CR 5200 (ETI Act s10(1))', async () => {
    // July left R2 000; August run PAYE R500, ETI nil: R500 used, R1 500 unused at the end of the period.
    route([{ period_year: 2026, period_month: 7, paye: 0, eti: 2_000 }]);
    const aug = { ...JUNE, period_month: 8, total_paye: 500, total_eti: 0, total_net: 39_100 };
    mockImpl = ((inner) => (strings: TemplateStringsArray, ...v: unknown[]) => {
      const q = strings.join('?');
      if (q.includes('payroll_run_headers') && !q.includes('total_paye AS paye') && !q.includes('information_schema')) return Promise.resolve([aug]);
      return inner(strings, ...v);
    })(mockImpl);
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    const emp201 = await generateEMP201(COMPANY, '2026-08-01', '2026-08-31');
    expect(emp201.etiCarry.refundClaimable).toBe(1_500);
    expect(debit(plan, '1150')).toBe(1_500);
    expect(credit(plan, '5200')).toBe(1_500);
    expect(credit(plan, '2140')).toBe(emp201.payePayable);
    expect(plan!.totalDebit).toBe(plan!.totalCredit);
    expect(plan!.blockers).toEqual([]);
  });

  it('R-C: a refund due with no account holding the role is a blocker, not a silent drop', async () => {
    systemAccounts = [];
    route([{ period_year: 2026, period_month: 7, paye: 0, eti: 2_000 }]);
    const aug = { ...JUNE, period_month: 8, total_paye: 500, total_eti: 0, total_net: 39_100 };
    mockImpl = ((inner) => (strings: TemplateStringsArray, ...v: unknown[]) => {
      const q = strings.join('?');
      if (q.includes('payroll_run_headers') && !q.includes('total_paye AS paye') && !q.includes('information_schema')) return Promise.resolve([aug]);
      return inner(strings, ...v);
    })(mockImpl);
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.blockers.map((b) => b.code)).toContain('missing_eti_refund_account');
  });

  it('H2: ETI a directive\'s ETI journal already booked this month is not booked again by the run', async () => {
    // June: R1 800 carried, run ETI R500, run PAYE R3 000: R2 300 used, of which an ETI journal booked R300.
    route([{ period_year: 2026, period_month: 5, paye: 200, eti: 2_000 }]);
    etiJournalsBooked = [{ used: 300, refund: 0 }];
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.totals.etiUsed).toBe(2_000);
    expect(credit(plan, '2140')).toBe(1_000);
    expect(plan!.totalDebit).toBe(plan!.totalCredit);
  });

  it('nothing brought forward into March: February\'s excess is a refund, not booked in March (s10(3))', async () => {
    route([{ period_year: 2026, period_month: 2, paye: 0, eti: 4_000 }]);
    mockImpl = ((inner) => (strings: TemplateStringsArray, ...v: unknown[]) => {
      const q = strings.join('?');
      if (q.includes('payroll_run_headers') && !q.includes('total_paye AS paye') && !q.includes('information_schema')) return Promise.resolve([{ ...JUNE, period_month: 3 }]);
      return inner(strings, ...v);
    })(mockImpl);
    const plan = await buildPayrollJournalPlan(COMPANY, RUN);
    expect(plan!.totals.etiUsed).toBe(500);
    expect(credit(plan, '2140')).toBe(2_500);
  });
});
