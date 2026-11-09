/**
 * Wave 4 PS / wave 5 FS: the payslip model built from a fixture run. Final versus DRAFT is the
 * approval time (`approved_at`, or `approval_grandfathered_at`), counted only while the
 * run is approved or paid. The finality query is answered by the fixture header as Postgres would. The PDF holds the
 * bank account's last four digits only and never an ID number.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Header = { status: string; approved_at: string | null; approval_grandfathered_at: string | null };
const db = vi.hoisted(() => ({ header: null as null | Record<string, unknown>, line: null as null | Record<string, unknown> }));

vi.mock('@/lib/neon', () => ({
  withSavepoint: vi.fn(),
  sql: vi.fn(async (strings: TemplateStringsArray) => {
    const q = strings.join('?');
    if (q.includes('FROM payroll_run_headers') && !q.includes('payroll_run_lines')) return db.header ? [db.header] : [];
    if (q.includes('FROM payroll_run_lines prl') && q.includes('component_breakdown')) {
      // The finality is computed by the lines' own statement, as Postgres would from the header row.
      expect(q).toContain('COALESCE(prh.approved_at, prh.approval_grandfathered_at) IS NOT NULL');
      const h = db.header;
      const run_final = !!h && ['approved', 'paid'].includes(String(h.status)) && !!(h.approved_at ?? h.approval_grandfathered_at);
      return [{ ...(db.line ?? LINE_ROW), run_final }];
    }
    if (q.includes('FROM payroll_components')) return [{ id: 'c-salary', component_type: 'earning' }, { id: 'c-med', component_type: 'deduction' }];
    if (q.includes('prl.taxable_income')) return [{ run_id: RUN, employee_id: EMP, gross_pay: 30000, taxable_income: 30000, paye: 5000, uif_employee: 177.12, net_pay: 23022.88 }];
    throw new Error(`unexpected query: ${q.slice(0, 120)}`);
  }),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/core/pdfShared', async (actual) => ({
  ...(await actual<object>()),
  getCompanyDetailsFromCompany: vi.fn(async () => ({ name: 'Fixture Payroll (Pty) Ltd', address: '1 Main Road, Durban' })),
}));

import { getPayslips } from '@/modules/accounting/services/payroll/payslipModel';
import { buildPayslipPdf, DRAFT_MARK } from '@/modules/accounting/services/payroll/payslipPdf';

const CO = '00000000-0000-4000-8000-0000000000c0';
const RUN = '00000000-0000-4000-8000-0000000000a1';
const EMP = '00000000-0000-4000-8000-0000000000e1';
const LINE_ROW = {
  employee_id: EMP, employee_number: 'E-001', first_name: 'Zanele', last_name: 'Slip',
  tax_number: '0123456789', payment_method: 'eft', bank_last_four: '3456', bank_name: 'FNB',
  occupation: 'Splicer', pay_basis: 'hourly', hours_per_week: '40.00', hours_per_day: '8.00', hourly_rate: '150.00', daily_rate: null,
  gross_pay: '30000.00', paye: '5000.00', uif_employee: '177.12', uif_employer: '177.12', sdl: '300.00', net_pay: '23022.88',
  component_breakdown: [
    { componentId: 'c-salary', componentName: 'Basic Salary', sarsSourceCode: '3601', amount: 30000, isTaxable: true, isUifApplicable: true },
    { componentId: 'c-med', componentName: 'Medical Aid', sarsSourceCode: '4005', amount: 1800, isTaxable: false, isUifApplicable: false },
  ],
};
const header = (h: Header) => ({ period_month: 11, period_year: 2026, run_date: '2026-11-25', total_gross: 30000, ...h });

async function pdfText(pdf: Buffer): Promise<string> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as {
    PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }> };
  };
  return (await new PDFParse({ data: pdf }).getText()).text.replace(/\s+/g, ' ');
}

beforeEach(() => { db.header = null; db.line = null; });

describe('getPayslips: the figures', () => {
  it('earnings, deductions, PAYE, UIF and net equal the stored line', async () => {
    db.header = header({ status: 'calculated', approved_at: null, approval_grandfathered_at: null });
    const [slip] = (await getPayslips(CO, RUN)).payslips;
    expect(slip).toMatchObject({
      employeeName: 'Zanele Slip', taxNumber: '0123456789', bankLastFour: '3456',
      grossPay: 30000, paye: 5000, uifEmployee: 177.12, netPay: 23022.88, otherDeductions: 1800, notItemised: false,
      earnings: [{ label: 'Basic Salary', code: '3601', amount: 30000 }],
      deductions: [{ label: 'Medical Aid', code: '4005', amount: 1800 }],
    });
    expect(slip!.yearToDate).toEqual({ grossPay: 30000, taxableIncome: 30000, paye: 5000, uifEmployee: 177.12, netPay: 23022.88 });
  });

  it('a breakdown stored as a JSON string is typed from the catalogue too, not left "Not itemised"', async () => {
    db.header = header({ status: 'calculated', approved_at: null, approval_grandfathered_at: null });
    db.line = { ...LINE_ROW, component_breakdown: JSON.stringify(LINE_ROW.component_breakdown) };
    const [slip] = (await getPayslips(CO, RUN)).payslips;
    expect(slip).toMatchObject({
      notItemised: false,
      earnings: [{ label: 'Basic Salary', code: '3601', amount: 30000 }],
      deductions: [{ label: 'Medical Aid', code: '4005', amount: 1800 }],
    });
  });

  it('another company\'s run (no header for this company) is not found', async () => {
    await expect(getPayslips(CO, RUN)).rejects.toThrow('Pay run not found');
  });
});

const AT = '2026-11-25T10:00:00Z';
describe('getPayslips: final or DRAFT, by the approval time only', () => {
  it.each([
    ['a calculated run', { status: 'calculated', approved_at: null, approval_grandfathered_at: null }, false],
    ['an approved row with neither approved_at nor grandfathered', { status: 'approved', approved_at: null, approval_grandfathered_at: null }, false],
    ['a calculated run carrying a stale approved_at', { status: 'calculated', approved_at: AT, approval_grandfathered_at: null }, false],
    ['an approved run', { status: 'approved', approved_at: AT, approval_grandfathered_at: null }, true],
    ['a grandfathered approved run', { status: 'approved', approved_at: null, approval_grandfathered_at: AT }, true],
    ['a paid run', { status: 'paid', approved_at: AT, approval_grandfathered_at: null }, true],
  ] as const)('%s', async (_name, row, final) => {
    db.header = header(row);
    expect((await getPayslips(CO, RUN)).final).toBe(final);
  });
});

describe('buildPayslipPdf', () => {
  it('prints DRAFT on a run that is not final, and the stored net', async () => {
    db.header = header({ status: 'approved', approved_at: null, approval_grandfathered_at: null });
    const text = await pdfText(await buildPayslipPdf(await getPayslips(CO, RUN)));
    expect(text).toContain(DRAFT_MARK);
    expect(text).toContain('23 022.88');
    expect(text).toContain('Fixture Payroll (Pty) Ltd');
    expect(text).toContain('Occupation: Splicer'); // from the profile; never the EE level or department
    expect(text).toContain('Ordinary hours: 8 per day, 40 per week (contracted)');
  });

  it('prints no DRAFT on a final run', async () => {
    db.header = header({ status: 'approved', approved_at: AT, approval_grandfathered_at: null });
    expect(await pdfText(await buildPayslipPdf(await getPayslips(CO, RUN)))).not.toContain('DRAFT');
  });

  it('holds the bank account\'s last four digits and no ID number', async () => {
    db.header = header({ status: 'calculated', approved_at: null, approval_grandfathered_at: null });
    const text = await pdfText(await buildPayslipPdf(await getPayslips(CO, RUN)));
    expect(text).toContain('\u2022\u2022\u2022\u2022 3456');
    expect(text).not.toContain('account ending');
    expect(text).not.toMatch(/\bID\b|identity/i);
  });
});
