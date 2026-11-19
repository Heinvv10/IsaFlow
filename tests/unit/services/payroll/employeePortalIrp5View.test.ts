/** Wave 6 SS-c: the portal's view of one filed certificate, and its PDF copy. */
import { describe, expect, it } from 'vitest';
import { certificateView } from '@/modules/accounting/services/payroll/employeePortalIrp5View';
import { buildIrp5CopyPdf, drawIrp5Copy, IRP5_COPY_NOTE } from '@/modules/accounting/services/payroll/employeePortalIrp5Pdf';
import type { StoredEmployee } from '@/modules/accounting/services/returns/emp501Figures';

const cert: StoredEmployee = {
  certificateNumber: '7000000000202602000000000000001', yearOfAssessment: 2026, surname: 'Dlamini', firstNames: 'Thandi Grace',
  initials: 'TG', idNumber: '8001015009087', taxNumber: '0123456789', employmentStartDate: '20200101', employmentEndDate: null,
  periodsInYoA: 12, grossSalary3601: 240000, paye4102: 30000.5, uifEmployee: 2125.44, uifEmployer: 2125.44, sdl4142: 2400,
  annualPayments3605: 20000, cashAllowances: [{ sourceCode: '3701', amount: 12000 }],
  lumpSums: [{ sourceCode: '3901', directiveNumber: 'D1', directiveIssuedDate: '20260110', amount: 50000, paye: 9000 }],
  retirementFund: { pension4001: 18000, provident4003: 0, annuity4006: 0, donations4030: 0 },
  medical: { fees: 24000, credit: 4392, additionalCredit: 0, age65OrOlder: false, recorded: true },
};
const version = { id: 'v1', filedAt: '2026-05-31T08:00:00.000Z', taxYear: 2026, kind: 'annual' as const };
const employer = { tradingName: 'Acme (Pty) Ltd', payeReferenceNumber: '7000000000' };

describe('certificateView', () => {
  it('lists the filed codes and amounts, nothing recalculated, with the ID and tax numbers cut to four', () => {
    const v = certificateView(version, employer, cert);
    expect(v.income).toEqual([
      { code: '3601', label: 'Salary', amount: 240000 }, { code: '3605', label: 'Annual payment (bonus)', amount: 20000 },
      { code: '3701', label: 'Travel allowance', amount: 12000 }, { code: '3901', label: 'Lump sum (tax directive)', amount: 50000 },
    ]);
    expect(v.deductions).toEqual([
      { code: '4001', label: 'Pension fund contributions', amount: 18000 }, { code: '4005', label: 'Medical scheme fees', amount: 24000 },
    ]);
    expect(v.tax.map((t) => [t.code, t.amount])).toEqual([['4102', 30000.5], ['4115', 9000], ['4116', 4392], ['4141', 4250.88], ['4142', 2400]]);
    expect([v.idNumberLast4, v.taxNumberLast4, v.employee, v.periodFrom, v.periodTo]).toEqual(['9087', '6789', 'Thandi Grace Dlamini', '2020-01-01', null]);
  });

  it('has no ID line when the certificate carries none', () => {
    expect(certificateView(version, employer, { ...cert, idNumber: '', taxNumber: null }).idNumberLast4).toBeNull();
  });
});

describe('buildIrp5CopyPdf', () => {
  it('renders the certificate with the numbers cut to four, the same bytes twice', async () => {
    const v = certificateView(version, employer, cert);
    const pdf = await buildIrp5CopyPdf(v);
    expect(pdf.equals(await buildIrp5CopyPdf(v))).toBe(true);
    const { PDFParse } = (await import('pdf-parse')) as unknown as { PDFParse: new (o: { data: Buffer }) => { getText(): Promise<{ text: string }> } };
    const text = (await new PDFParse({ data: Buffer.from(pdf) }).getText()).text;
    expect(text).toContain(cert.certificateNumber);
    expect(text).toContain('ending 9087');
    expect(text).not.toContain('8001015009087');
    expect(text).not.toContain('0123456789');
    expect(text).toContain('not the SARS certificate form');
  });
});

describe('buildIrp5CopyPdf layout (review #1649 L3)', () => {
  it('keeps every text it places inside the margins, with a very long employer name and many code rows', async () => {
    // 52 rows end the last table at about 282 mm on page 2 (measured), so the note must start page 3.
    const many = Array.from({ length: 52 }, (_, i) => ({ sourceCode: String(3801 + i), amount: 1000 + i }));
    const long = 'The Extremely Long Registered Trading Name Of A South African Employer (Proprietary) Limited '.repeat(4).trim();
    const v = certificateView(version, { ...employer, tradingName: long }, { ...cert, fringeBenefits: many });
    const [{ jsPDF }, { default: autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const W = doc.internal.pageSize.getWidth();
    const H = doc.internal.pageSize.getHeight();
    const placed: Array<{ line: string; x: number; y: number; page: number; right: number }> = [];
    const text = doc.text.bind(doc);
    // Watch every text the copy draws itself (autoTable's cells are its own, kept in bounds by its margins).
    doc.text = ((t: string | string[], x: number, y: number, ...rest: unknown[]) => {
      [t].flat().forEach((line, k) => placed.push({
        line, x, y: y + k * doc.getLineHeight() / doc.internal.scaleFactor, page: doc.getCurrentPageInfo().pageNumber,
        right: x + doc.getTextWidth(line),
      }));
      return (text as (...a: unknown[]) => unknown)(t, x, y, ...rest);
    }) as typeof doc.text;
    drawIrp5Copy(doc, autoTable, v);
    const outside = placed.filter((p) => p.x < 14 || p.right > W - 14 + 0.01 || p.y > H - 14 + 0.01);
    expect(outside.map((p) => `${p.line.slice(0, 30)}… page ${p.page} right=${p.right.toFixed(1)} y=${p.y.toFixed(1)}`)).toEqual([]);
    expect(placed.some((p) => p.line.endsWith('Limited (PAYE 7000000000)'))).toBe(true);
    const note = placed.filter((p) => IRP5_COPY_NOTE.startsWith(p.line.slice(0, 20)));
    expect(note[0]?.page).toBe(doc.getNumberOfPages());
  });
});
