/**
 * The PDF a payslip email attaches, and the message around it (wave 6 PE; spec §0a.10, §0a.18, grill F14).
 *
 * The PDF is the payslip render (payslipPdf, from PS3's frozen details) of ONE employee's slip, protected with the
 * employee's ID number, else their passport number. An employee with neither has no password and is never sent a
 * slip (`payslipPassword` returns null; the send skips and names them).
 *
 * WEAK ENCRYPTION (said here, in the PR, and in the setting's help text). jsPDF's only encryption is the PDF 1.3
 * standard handler, revision 2: RC4 with a 40-bit key (jspdf.node.js PDFSecurity: v 1, r 2, a five-byte key). A
 * 40-bit key can be searched whatever the password is, and an SA ID number starts with the date of birth. It keeps
 * a slip from a casual reader of a forwarded mail or a shared inbox, not from someone set on opening it.
 *
 * Deterministic (F14): the creation date is the run's approval time and the file id is derived from the run, the
 * employee and that approval, so the same final slip always renders to the same bytes, and `sha256` is the hash of
 * exactly the bytes attached.
 */
import { createHash } from 'crypto';
import { escapeHtml } from '@/modules/accounting/services/packs/escapeHtml';
import { buildPayslipPdf, payslipFilename } from './payslipPdf';
import type { Payslip, PayslipRun } from './payslipModel';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export type PasswordSource = 'id_number' | 'passport_number';

/** The slip's password: the ID number, else the passport number (spaces removed); null when neither is on file. */
export function payslipPassword(e: { idNumber: string | null; passportNumber: string | null }): { password: string; source: PasswordSource } | null {
  const id = (e.idNumber ?? '').replace(/\s+/g, '');
  if (id !== '') return { password: id, source: 'id_number' };
  const passport = (e.passportNumber ?? '').replace(/\s+/g, '');
  return passport !== '' ? { password: passport, source: 'passport_number' } : null;
}

export interface EmailPayslipPdf { filename: string; pdf: Buffer; sha256: string }

/** One employee's slip, protected and deterministic. `approvedAt` is the run's current approval time. */
export async function renderEmailPayslip(run: PayslipRun, slip: Payslip, password: string, approvedAt: Date): Promise<EmailPayslipPdf> {
  const fileId = createHash('sha256').update(`payslip-email:${run.runId}:${slip.employeeId}:${approvedAt.toISOString()}`)
    .digest('hex').slice(0, 32);
  const pdf = await buildPayslipPdf({ ...run, payslips: [slip] }, { password, createdAt: approvedAt, fileId });
  return { filename: payslipFilename(run, slip.employeeNumber), pdf, sha256: createHash('sha256').update(pdf).digest('hex') };
}

/** The subject and body. The password itself is never in the mail; only which document it is. */
export function payslipEmailMessage(run: PayslipRun, slip: Payslip, source: PasswordSource): { subject: string; html: string } {
  const period = `${MONTHS[run.periodMonth - 1]} ${run.periodYear}`;
  const doc = source === 'id_number' ? 'your South African ID number' : 'your passport number';
  const employer = escapeHtml(run.employer.name);
  return {
    subject: `Your payslip for ${period} from ${run.employer.name}`.replace(/[\r\n]+/g, ' '),
    html: `<p>Dear ${escapeHtml(slip.employeeName)},</p>`
      + `<p>Your payslip for ${period} from ${employer} is attached as a PDF.</p>`
      + `<p>To open it, enter ${doc} as the password, with no spaces.</p>`
      + '<p>If you did not expect this email, please tell your employer and delete it.</p>',
  };
}
