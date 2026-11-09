/**
 * Wave 4 PS review fixes: the payslip PDF itself, from a PayslipRun built here.
 * - A DRAFT slip carries the DRAFT line and the watermark on EVERY page, a slip that flows
 *   onto a second or third page included; a final one carries neither.
 * - The "Not itemised" note is worded by cause and lands on a page (never off the bottom).
 * - Total deductions is rounded like every other figure.
 * - BCEA s33(1): the employer's address, or a visible "Employer address not recorded" on a
 *   final slip; "Occupation not recorded" (payroll has no occupation field).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => { throw new Error('no database in this test'); }), withSavepoint: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { buildPayslipPdf, DRAFT_MARK, notePlacement } from '@/modules/accounting/services/payroll/payslipPdf';
import { itemisePayslip, NOT_ITEMISED } from '@/modules/accounting/services/payroll/payslipItems';
import type { Payslip, PayslipRun } from '@/modules/accounting/services/payroll/payslipModel';

const item = (id: string, name: string, code: string, amount: number) =>
  ({ componentId: id, componentName: name, sarsSourceCode: code, amount, isTaxable: true, isUifApplicable: true });

function slipOf(breakdown: object[], types: Map<string, string>, stored: { gross: number; paye: number; uif: number; net: number }): Payslip {
  return {
    ...itemisePayslip({
      grossPay: stored.gross, paye: stored.paye, uifEmployee: stored.uif, uifEmployer: stored.uif, sdl: 0, netPay: stored.net, breakdown,
    }, types),
    employeeId: 'e1', employeeNumber: 'E-001', employeeName: 'Zanele Slip', taxNumber: '0123456789', paymentMethod: 'eft',
    bankLastFour: '3456', bankName: 'FNB', bankIncomplete: false,
    occupation: null, payBasis: 'monthly', hoursPerWeek: null, hoursPerDay: null, hourlyRate: null, dailyRate: null,
    yearToDate: { grossPay: stored.gross, taxableIncome: stored.gross, paye: stored.paye, uifEmployee: stored.uif, netPay: stored.net },
  };
}

const runOf = (slip: Payslip, final: boolean, address = '1 Main Road, Durban'): PayslipRun => ({
  runId: 'r1', periodMonth: 11, periodYear: 2026, runDate: '2026-11-25', final,
  employer: { name: 'Fixture Payroll (Pty) Ltd', address }, payslips: [slip],
});

/** 70 earnings and 50 deductions: the slip flows over several pages. */
function longSlip(): Payslip {
  const earnings = Array.from({ length: 70 }, (_, i) => item(`e${i}`, `Allowance ${i + 1}`, '3713', 100));
  const deductions = Array.from({ length: 50 }, (_, i) => item(`d${i}`, `Deduction ${i + 1}`, '4497', 10));
  const types = new Map([...earnings.map((e) => [e.componentId, 'earning'] as const), ...deductions.map((d) => [d.componentId, 'deduction'] as const)]);
  // Stored net R10 below gross − PAYE − UIF − items, so a "Not itemised" note follows the last table.
  return slipOf([...earnings, ...deductions], types, { gross: 7000, paye: 700, uif: 70, net: 5720 });
}

async function pages(pdf: Buffer): Promise<string[]> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as {
    PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ pages: Array<{ num: number; text: string }> }> };
  };
  return (await new PDFParse({ data: pdf }).getText()).pages.map((p) => p.text.replace(/\s+/g, ' '));
}
const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('DRAFT on every page', () => {
  it('a long DRAFT slip: every page carries the DRAFT line and the watermark', async () => {
    const texts = await pages(await buildPayslipPdf(runOf(longSlip(), false)));
    expect(texts.length).toBeGreaterThanOrEqual(2);
    texts.forEach((t, i) => expect(count(t, DRAFT_MARK), `page ${i + 1}`).toBeGreaterThanOrEqual(2));
  });

  it('a long final slip: no page says DRAFT', async () => {
    const texts = await pages(await buildPayslipPdf(runOf(longSlip(), true)));
    expect(texts.length).toBeGreaterThanOrEqual(2);
    for (const t of texts) expect(t).not.toContain('DRAFT');
  });

  it('the "Not itemised" note is printed in full on the last page', async () => {
    const slip = longSlip();
    expect(slip.deductions.at(-1)).toEqual({ label: NOT_ITEMISED, code: '', amount: 10 });
    const texts = await pages(await buildPayslipPdf(runOf(slip, false)));
    expect(texts.at(-1)).toContain('The totals are the stored figures.');
  });
});

describe('notePlacement: the note never runs off the bottom of an A4 page (297 mm, 14 mm margin)', () => {
  it('fits below the last table: stays on the page', () => {
    expect(notePlacement(200, 3, 297)).toEqual({ newPage: false, y: 202 });
    expect(notePlacement(270.2, 3, 297)).toEqual({ newPage: false, y: 272.2 }); // ends at 283 exactly
  });

  it('would cross the bottom margin: a new page, at the top', () => {
    expect(notePlacement(271, 3, 297)).toEqual({ newPage: true, y: 18 });
    expect(notePlacement(290, 1, 297).newPage).toBe(true);
  });
});

describe('figures and particulars', () => {
  it('total deductions prints to the cent', async () => {
    // PAYE 0.1 + UIF 0.2 is 0.30000000000000004 in floating point. fmtZAR's toFixed(2) already prints 0.30, so
    // this pins the printed figure; the round2 in payslipPdf keeps the figure itself exact like every other one.
    const types = new Map([['s', 'earning']]);
    const slip = slipOf([item('s', 'Salary', '3601', 100)], types, { gross: 100, paye: 0.1, uif: 0.2, net: 99.7 });
    expect(slip.paye + slip.uifEmployee + slip.otherDeductions).not.toBe(0.3);
    const [text] = await pages(await buildPayslipPdf(runOf(slip, true)));
    expect(text).toMatch(/Total deductions R ?0\.30/);
  });

  it('a negative gap is explained as items exceeding the stored total', async () => {
    const types = new Map([['s', 'earning'], ['g', 'deduction']]);
    const slip = slipOf([item('s', 'Salary', '3601', 5000), item('g', 'Garnishee', '4102', 6000)], types, { gross: 5000, paye: 0, uif: 50, net: 0 });
    const [text] = await pages(await buildPayslipPdf(runOf(slip, true)));
    expect(text).toContain('more than the stored total');
    expect(text).not.toContain('calculated before items were recorded');
  });

  it('occupation: "Occupation not recorded" when none is captured', async () => {
    const [text] = await pages(await buildPayslipPdf(runOf(longSlip(), true)));
    expect(text).toContain('Occupation: not recorded');
  });

  it('a FINAL slip with no employer address says "Employer address not recorded"', async () => {
    const [text] = await pages(await buildPayslipPdf(runOf(longSlip(), true, '')));
    expect(text).toContain('Employer address not recorded');
    const [withAddress] = await pages(await buildPayslipPdf(runOf(longSlip(), true)));
    expect(withAddress).toContain('1 Main Road, Durban');
    expect(withAddress).not.toContain('Employer address not recorded');
  });

  it('an employer contribution from the breakdown is printed with the employer contributions, not as pay', async () => {
    const types = new Map([['s', 'earning'], ['er', 'employer_contribution']]);
    const slip = slipOf([item('s', 'Salary', '3601', 100), item('er', 'Employer Pension', '4472', 15)], types, { gross: 100, paye: 0, uif: 1, net: 99 });
    const [text] = await pages(await buildPayslipPdf(runOf(slip, true)));
    expect(text.indexOf('Employer Pension')).toBeGreaterThan(text.indexOf('Employer contributions'));
  });
});

describe('PS2: BCEA s33(1) particulars, formats, payment line', () => {
  const base = () => slipOf([item('s', 'Salary', '3601', 100)], new Map([['s', 'earning']]), { gross: 100, paye: 0, uif: 1, net: 99 });
  const textOf = async (slip: Payslip, run: Partial<PayslipRun> = {}) =>
    (await pages(await buildPayslipPdf({ ...runOf(slip, true), ...run })))[0]!;

  it('prints the captured occupation, hours and rate', async () => {
    const slip = { ...base(), occupation: 'Splicer', payBasis: 'hourly', hoursPerWeek: 40, hoursPerDay: 8, hourlyRate: 1234.5 };
    const text = await textOf(slip);
    expect(text).toContain('Occupation: Splicer');
    expect(text).toContain('Ordinary hours: 8 per day, 40 per week (contracted)');
    expect(text).toContain('Rate of pay: R 1 234.50 per hour');
    expect(text).toContain('Overtime hours: not recorded');
  });

  it('prints "not recorded" for hours when none are stored, never a figure', async () => {
    const text = await textOf(base());
    expect(text).toContain('Ordinary hours: not recorded');
    expect(text).not.toContain('Rate of pay');
  });

  it('dates and money use the app formats', async () => {
    const text = await textOf(base());
    expect(text).toContain('Pay date: 25 Nov 2026');
    expect(text).toContain('01 Nov 2026 to 30 Nov 2026');
    expect(text).not.toContain('25/11/2026');
    expect(text).toMatch(/Gross pay R 100\.00/);
  });

  it('no pay-date line when the run has no pay date', async () => {
    expect(await textOf(base(), { runDate: null })).not.toContain('Pay date');
  });

  it('Paid by: EFT with last four, Cash, EFT with no bank details', async () => {
    expect(await textOf(base())).toContain('Paid by: EFT to FNB \u2022\u2022\u2022\u2022 3456');
    expect(await textOf({ ...base(), paymentMethod: 'cash' })).toContain('Paid by: Cash');
    expect(await textOf({ ...base(), bankLastFour: null, bankName: null })).toContain('Paid by: EFT: bank details missing');
    expect(await textOf({ ...base(), bankLastFour: null, bankIncomplete: true })).toContain('Paid by: EFT: bank details incomplete');
  });

  it('the employer address never prints empty parts', async () => {
    const text = await textOf(base(), { employer: { name: 'Fixture Payroll (Pty) Ltd', address: '1 Main Road, , ,  , Durban, ' } });
    expect(text).toContain('1 Main Road, Durban');
    expect(text).not.toMatch(/, ,|,\s*,/);
  });

  it('a FINAL slip keeps rendering with nothing captured', async () => {
    const text = await textOf({ ...base(), occupation: null, bankLastFour: null, taxNumber: null }, { runDate: null });
    expect(text).toContain('Net pay');
    expect(text).not.toContain('DRAFT');
  });
});
