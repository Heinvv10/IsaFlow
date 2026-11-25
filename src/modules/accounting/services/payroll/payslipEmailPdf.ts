/**
 * The PDF a payslip email attaches, and the message around it (wave 6 PE; spec §0a.10, §0a.18, grill F14; wave 7 PX).
 *
 * The PDF is the payslip render (payslipPdf, from PS3's frozen details) of ONE employee's slip, protected with the
 * employee's ID number, else their passport number. An employee with neither has no password and is never sent a
 * slip (`payslipPassword` returns null; the send skips and names them).
 *
 * ENCRYPTION (wave 7 PX, W15, ruling 2): AES-256 (PDF R 6) by qpdf over jsPDF's unencrypted render
 * (payslipEncrypt), replacing jsPDF's own RC4-40. The cipher is strong; the password is not (Hein's ruling 21: keep it,
 * say the truth). An SA ID number is the date of birth (6 digits) plus 7 digits, one a Luhn check digit and one
 * nearly fixed, so anyone who knows or can guess the employee's date of birth can open the slip, and without the
 * date of birth the remaining space can still be searched (cracked) in hours. Said on the card and in the
 * confirmation (PayslipEmailCard WEAK_PROTECTION).
 *
 * Hashes (ruling 17): `plaintextSha256` is the hash of the unencrypted render, which is deterministic (F14: the
 * creation date is the run's approval time and the file id is derived from the run, the employee and that approval),
 * so the same final slip always has the same plaintext hash. `sha256` is the hash of exactly the bytes attached;
 * AES encryption is salted, so every send of the same slip has a different `sha256`.
 */
import { createHash } from 'crypto';
import { escapeHtml } from '@/modules/accounting/services/packs/escapeHtml';
import { buildPayslipPdf, payslipFilename } from './payslipPdf';
import { encryptPayslipPdf, type EncryptDeps } from './payslipEncrypt';
import type { Payslip, PayslipRun } from './payslipModel';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export type PasswordSource = 'id_number' | 'passport_number';

/** A value with a control character left after removing whitespace (NUL, say) is no password: never passed to qpdf. */
const usable = (v: string): boolean => v !== '' && !/[\u0000-\u001f\u007f]/.test(v);

/**
 * The slip's password: the ID number, else the passport number (spaces removed); null when neither is on file as a
 * usable value (the send skips and names the employee, NO_ID_OR_PASSPORT).
 */
export function payslipPassword(e: { idNumber: string | null; passportNumber: string | null }): { password: string; source: PasswordSource } | null {
  const id = (e.idNumber ?? '').replace(/\s+/g, '');
  if (usable(id)) return { password: id, source: 'id_number' };
  const passport = (e.passportNumber ?? '').replace(/\s+/g, '');
  return usable(passport) ? { password: passport, source: 'passport_number' } : null;
}

export interface EmailPayslipPdf { filename: string; pdf: Buffer; sha256: string; plaintextSha256: string }

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/**
 * One employee's slip, AES-256 protected. `approvedAt` is the run's current approval time. Throws
 * PayslipEncryptionFailed when it cannot be encrypted (never returns it unprotected).
 */
export async function renderEmailPayslip(
  run: PayslipRun, slip: Payslip, password: string, approvedAt: Date, deps?: EncryptDeps,
): Promise<EmailPayslipPdf> {
  const fileId = createHash('sha256').update(`payslip-email:${run.runId}:${slip.employeeId}:${approvedAt.toISOString()}`)
    .digest('hex').slice(0, 32);
  const plaintext = await buildPayslipPdf({ ...run, payslips: [slip] }, { createdAt: approvedAt, fileId });
  const pdf = await encryptPayslipPdf(plaintext, password, deps);
  return { filename: payslipFilename(run, slip.employeeNumber), pdf, sha256: sha256(pdf), plaintextSha256: sha256(plaintext) };
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
