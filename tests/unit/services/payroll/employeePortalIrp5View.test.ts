/** Wave 6 SS-c: the portal's view of one filed certificate, and its PDF copy. */
import { describe, expect, it } from 'vitest';
import { certificateView } from '@/modules/accounting/services/payroll/employeePortalIrp5View';
import { buildIrp5CopyPdf } from '@/modules/accounting/services/payroll/employeePortalIrp5Pdf';
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

/** Every text item of every page, with the page's size (pdfjs reads the positions jsPDF wrote). */
async function textItems(pdf: Buffer): Promise<Array<{ str: string; x: number; y: number; w: number; pageW: number; pageH: number }>> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const docu = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
  const out: Array<{ str: string; x: number; y: number; w: number; pageW: number; pageH: number }> = [];
  for (let n = 1; n <= docu.numPages; n += 1) {
    const page = await docu.getPage(n);
    const { width, height } = page.getViewport({ scale: 1 });
    for (const it of (await page.getTextContent()).items as Array<{ str: string; transform: number[]; width: number }>) {
      if (it.str.trim()) out.push({ str: it.str, x: it.transform[4]!, y: it.transform[5]!, w: it.width, pageW: width, pageH: height });
    }
  }
  return out;
}

describe('buildIrp5CopyPdf layout (review #1649 L3)', () => {
  it('keeps every text inside the page with a very long employer name and many code rows', async () => {
    const many = Array.from({ length: 70 }, (_, i) => ({ sourceCode: String(3801 + i), amount: 1000 + i }));
    const long = 'The Extremely Long Registered Trading Name Of A South African Employer (Proprietary) Limited '.repeat(4).trim();
    const v = certificateView(version, { ...employer, tradingName: long }, { ...cert, fringeBenefits: many });
    const items = await textItems(await buildIrp5CopyPdf(v));
    const outside = items.filter((i) => i.x < 0 || i.x + i.w > i.pageW + 0.5 || i.y < 0 || i.y > i.pageH);
    expect(outside).toEqual([]);
    const text = items.map((i) => i.str).join(' ');
    expect(text).toContain('Limited');
    expect(text).toContain('not the SARS certificate form');
    expect(text).toContain(String(3801 + 69));
  });
});

