/**
 * Wave 6 PE (grill F14): the emailed payslip PDF.
 *  - it opens only with the employee's password, and what it says then is exactly what the unprotected render says;
 *  - wave 7 PX: it is AES-256 (R 6), not RC4-40; the same slip renders to the same PLAINTEXT (fixed creation date and
 *    file id), so plaintext_sha256 is reproducible, while each encryption is salted, so pdf_sha256 is per send;
 *  - the password is the ID number, else the passport number; neither = no password (never sent unprotected);
 *  - the mail never carries the password, and the subject cannot carry a header.
 */
import { createHash } from 'crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn(async () => { throw new Error('no database in this test'); }), withSavepoint: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { buildPayslipPdf } from '@/modules/accounting/services/payroll/payslipPdf';
import { payslipEmailMessage, payslipPassword, renderEmailPayslip } from '@/modules/accounting/services/payroll/payslipEmailPdf';
import { itemisePayslip } from '@/modules/accounting/services/payroll/payslipItems';
import type { Payslip, PayslipRun } from '@/modules/accounting/services/payroll/payslipModel';

const slip: Payslip = {
  ...itemisePayslip({ grossPay: 25000, paye: 3500, uifEmployee: 177.12, uifEmployer: 177.12, sdl: 250, netPay: 21322.88, breakdown: [] }, new Map()),
  employeeId: '11111111-1111-4111-8111-111111111111', employeeNumber: 'E-001', employeeName: 'Zanele Slip', taxNumber: '0123456789',
  paymentMethod: 'eft', bankLastFour: '3456', bankName: 'FNB', bankIncomplete: false, workedOrdinary: null, workedOvertime: null,
  occupation: 'Clerk', payBasis: 'monthly', hoursPerWeek: null, hoursPerDay: null, hourlyRate: null, dailyRate: null,
  yearToDate: { grossPay: 25000, taxableIncome: 25000, paye: 3500, uifEmployee: 177.12, netPay: 21322.88 },
};
const run: PayslipRun = {
  runId: '22222222-2222-4222-8222-222222222222', periodMonth: 11, periodYear: 2026, runDate: '2026-11-25', final: true,
  detailsAsAt: 'approval', employer: { name: 'Fixture <Payroll>\r\nBcc: x@example.invalid', address: '1 Main Road, Durban' }, payslips: [slip],
};
const APPROVED = new Date('2026-11-17T04:12:33.123Z');
const ID = '8001015009087';

type Parser = new (o: { data: Buffer; password?: string }) => { getText(): Promise<{ text: string }> };
async function text(pdf: Buffer, password?: string): Promise<string> {
  const { PDFParse } = (await import('pdf-parse')) as unknown as { PDFParse: Parser };
  return (await new PDFParse({ data: Buffer.from(pdf), ...(password === undefined ? {} : { password }) }).getText()).text.replace(/\s+/g, ' ');
}

describe('the emailed payslip PDF', () => {
  it('opens only with the password, and then reads exactly as the unprotected render', async () => {
    const { pdf } = await renderEmailPayslip(run, slip, ID, APPROVED);
    expect(pdf.subarray(0, 8).toString('latin1')).toMatch(/^%PDF-1\./);
    expect(pdf.toString('latin1')).toMatch(/\/Encrypt \d+ 0 R/);
    expect(pdf.toString('latin1')).toMatch(/\/R 6\b/);
    expect(pdf.toString('latin1')).toMatch(/\/AESV3\b/);
    await expect(text(pdf)).rejects.toThrow(/password/i);
    await expect(text(pdf, '8001015009088')).rejects.toThrow(/password/i);
    const plain = await text(await buildPayslipPdf({ ...run, payslips: [slip] }));
    expect(plain).toContain('Zanele Slip');
    expect(await text(pdf, ID)).toBe(plain);
  });

  it('the same slip has the same plaintext hash; sha256 is the hash of the bytes attached, new on every encryption', async () => {
    const a = await renderEmailPayslip(run, slip, ID, APPROVED);
    const b = await renderEmailPayslip(run, slip, ID, APPROVED);
    const plain = await buildPayslipPdf({ ...run, payslips: [slip] }, {
      createdAt: APPROVED,
      fileId: createHash('sha256').update(`payslip-email:${run.runId}:${slip.employeeId}:${APPROVED.toISOString()}`).digest('hex').slice(0, 32),
    });
    expect(a.plaintextSha256).toBe(createHash('sha256').update(plain).digest('hex'));
    expect(b.plaintextSha256).toBe(a.plaintextSha256);
    expect(a.sha256).toBe(createHash('sha256').update(a.pdf).digest('hex'));
    expect(b.sha256).not.toBe(a.sha256);
    expect(a.sha256).not.toBe(a.plaintextSha256);
    expect(a.filename).toBe('payslip-2026-11-E-001.pdf');
    // Another approval of the run is another document.
    expect((await renderEmailPayslip(run, slip, ID, new Date('2026-11-18T00:00:00Z'))).plaintextSha256).not.toBe(a.plaintextSha256);
  });

  it('the password: the ID number, else the passport number, else none', () => {
    expect(payslipPassword({ idNumber: ' 800101 5009 087 ', passportNumber: 'A1' })).toEqual({ password: ID, source: 'id_number' });
    expect(payslipPassword({ idNumber: '  ', passportNumber: 'M 1234567' })).toEqual({ password: 'M1234567', source: 'passport_number' });
    expect(payslipPassword({ idNumber: null, passportNumber: null })).toBeNull();
    // Wave 7 PX: a control character (NUL, say) is no password; the passport is used, else none.
    expect(payslipPassword({ idNumber: '8001\u00005009087', passportNumber: 'M1234567' })).toEqual({ password: 'M1234567', source: 'passport_number' });
    expect(payslipPassword({ idNumber: '8001\u0000', passportNumber: 'M\u0007' })).toBeNull();
  });

  it('the mail names the document, never the password, and the subject is one line', () => {
    const m = payslipEmailMessage(run, slip, 'id_number');
    expect(m.subject).toBe('Your payslip for November 2026 from Fixture <Payroll> Bcc: x@example.invalid');
    expect(m.html).toContain('your South African ID number');
    expect(m.html).not.toContain(ID);
    expect(m.html).toContain('Fixture &lt;Payroll&gt;');
    expect(payslipEmailMessage(run, slip, 'passport_number').html).toContain('your passport number');
  });
});
