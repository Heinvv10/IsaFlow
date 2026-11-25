/**
 * What "Mark paid" judges before it writes anything (wave 7 MP, W27; Hein rulings 4 and 16; grill F2). Read-only:
 * each judge throws a PayrollRunMarkPaidRefusal naming what to do instead.
 *
 *   parseTypedPayment    the typed path's shape (before any lock): a bank payment reference (1-64 characters after
 *                        trimming; blank or whitespace-only refused) and a real payment date, both or neither.
 *   judgePaidOnWindow    the typed date: not before the day the run was approved (SAST), not after today (SAST).
 *   judgeRunJournal      the run links its OWN payroll journal (source auto_payroll, the run's description, posted) and
 *                        that journal is in force by the ledger (gl_journal_in_force, migration 1018: the reversal
 *                        chain's parity, never the reversed_at stamp). A run whose journal never posted, or was
 *                        reversed, is not marked paid: the GL would show nothing owed and nothing paid.
 *   judgeBankFileEvidence the file path: no salary bank file still `generated` (it may be at the bank: confirm or void it
 *                        first; this holds for the typed path too), a `confirmed` file whose total equals the run's
 *                        net pay and whose per-employee settlement (payrollBankFileSettlement) owes and overpays
 *                        nothing, with an action date not after today. The payment date is the file's action date.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { formatCents } from '@/lib/money/formatMoney';
import { listRunBankFiles } from './payrollBankFileStatus';
import { fileSettlement } from './payrollBankFileSettlement';
import { runJournalDescriptionOf } from './payrollJournalDescription';

export type MarkPaidRefusalReason =
  | 'NOT_FOUND' | 'ALREADY_PAID' | 'NOT_APPROVED' | 'NOT_FINAL' | 'JOURNAL_NOT_IN_FORCE' | 'UNSETTLED_FILE'
  | 'NO_PAYMENT_EVIDENCE' | 'FILE_TOTALS_DIFFER' | 'INVALID_REFERENCE' | 'INVALID_PAID_ON';

const STATUS: Record<MarkPaidRefusalReason, 400 | 404 | 409> = {
  NOT_FOUND: 404, ALREADY_PAID: 409, NOT_APPROVED: 409, NOT_FINAL: 409, JOURNAL_NOT_IN_FORCE: 409, UNSETTLED_FILE: 409,
  NO_PAYMENT_EVIDENCE: 409, FILE_TOTALS_DIFFER: 409, INVALID_REFERENCE: 400, INVALID_PAID_ON: 400,
};

/** Raised before any write of the request; the route answers it with `status` and `reason`. */
export class PayrollRunMarkPaidRefusal extends Error {
  readonly code = 'PAYROLL_MARK_PAID_REFUSED';
  readonly status: 400 | 404 | 409;
  constructor(readonly reason: MarkPaidRefusalReason, message: string) {
    super(message);
    this.name = 'PayrollRunMarkPaidRefusal';
    this.status = STATUS[reason];
  }
}

export interface TypedPayment { reference: string; paidOn: string }

export const MAX_PAID_REFERENCE = 64;

const isRealDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/** The typed path's input, or null for the file path (neither sent). Shape only: the dates are judged under the lock. */
export function parseTypedPayment(input: { reference?: string | null; paidOn?: string | null }): TypedPayment | null {
  if (input.reference == null && input.paidOn == null) return null;
  const reference = (input.reference ?? '').trim();
  if (reference.length === 0) {
    throw new PayrollRunMarkPaidRefusal('INVALID_REFERENCE', 'Type the bank payment reference (it cannot be blank).');
  }
  // S1 (review #1911): no control, format or bidi characters (\p{Cc}, \p{Cf}) nor line or paragraph separators: the
  // reference is shown and exported as typed, and these change how it reads.
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(reference)) {
    throw new PayrollRunMarkPaidRefusal('INVALID_REFERENCE', 'The bank payment reference has an invisible or control character: type it again.');
  }
  if (reference.length > MAX_PAID_REFERENCE) {
    throw new PayrollRunMarkPaidRefusal('INVALID_REFERENCE', `The bank payment reference is at most ${MAX_PAID_REFERENCE} characters.`);
  }
  const paidOn = input.paidOn ?? '';
  if (!isRealDate(paidOn)) {
    throw new PayrollRunMarkPaidRefusal('INVALID_PAID_ON', 'The payment date must be a real date (YYYY-MM-DD).');
  }
  return { reference, paidOn };
}

/** The payment date lies between the approval day and today, both SAST and inclusive. */
export function judgePaidOnWindow(paidOn: string, approvedOn: string, today: string): void {
  if (paidOn < approvedOn) {
    throw new PayrollRunMarkPaidRefusal('INVALID_PAID_ON', `The payment date ${paidOn} is before the run was approved (${approvedOn}).`);
  }
  if (paidOn > today) {
    throw new PayrollRunMarkPaidRefusal('INVALID_PAID_ON', `The payment date ${paidOn} is in the future: mark the run paid once the bank has paid it.`);
  }
}

/** The run's own payroll journal, posted and in force; the approval day (SAST) for the date window. */
export async function judgeRunJournal(companyId: string, run: DbRow): Promise<{ approvedOn: string }> {
  const row = ((await sql`
    SELECT ((COALESCE(h.approved_at, h.approval_grandfathered_at) AT TIME ZONE 'Africa/Johannesburg')::date)::text AS approved_on,
           je.entry_number,
           (je.id IS NOT NULL AND je.status = 'posted' AND public.gl_journal_in_force(je.id)) AS in_force
      FROM payroll_run_headers h
      LEFT JOIN gl_journal_entries je
        ON je.id = h.journal_entry_id AND je.company_id = h.company_id
       AND je.source = 'auto_payroll' AND je.description = ${runJournalDescriptionOf(run)}
     WHERE h.id = ${String(run.id)}::uuid AND h.company_id = ${companyId}::uuid
  `) as DbRow[])[0];
  if (!row || row.in_force !== true) {
    const named = row?.entry_number ? `Its journal ${String(row.entry_number)} is not in force (reversed or not posted). ` : '';
    throw new PayrollRunMarkPaidRefusal('JOURNAL_NOT_IN_FORCE',
      `${named}This run has no posted payroll journal of its own in the ledger, so it cannot be marked paid. `
      + 'Post its journal first (approve it again), then mark it paid.');
  }
  return { approvedOn: String(row.approved_on) };
}

/** A generated file may be at the bank: settle it first, whichever path marks the run paid. */
export async function judgeNoUnsettledFile(companyId: string, runId: string): Promise<void> {
  const files = await listRunBankFiles(companyId, runId);
  const live = files.find((f) => f.status === 'generated');
  if (live) {
    throw new PayrollRunMarkPaidRefusal('UNSETTLED_FILE',
      `A salary bank file for this run (${formatCents(live.totalCents)}, action date ${live.actionDate}) was generated and not settled. `
      + 'If the bank paid it, record that it was accepted; if it was never sent, void it saying so. Then mark the run paid.');
  }
}

/** The file path's evidence: the run's confirmed file, paying exactly the run. */
export async function judgeBankFileEvidence(
  companyId: string, run: DbRow, today: string,
): Promise<{ fileId: string; sha256: string; paidOn: string }> {
  const runId = String(run.id);
  const confirmed = (await listRunBankFiles(companyId, runId)).find((f) => f.status === 'confirmed');
  if (!confirmed) {
    throw new PayrollRunMarkPaidRefusal('NO_PAYMENT_EVIDENCE',
      'Nothing shows this run was paid: no salary bank file of it was confirmed. Record the bank\'s acceptance of its bank file, '
      + 'or type the bank payment reference and the payment date.');
  }
  const runCents = Math.round(Number(run.total_net) * 100);
  const settlement = await fileSettlement(companyId, runId, confirmed.id);
  if (confirmed.totalCents !== runCents || settlement.owedCents !== 0 || settlement.overpaidCents !== 0) {
    throw new PayrollRunMarkPaidRefusal('FILE_TOTALS_DIFFER',
      `The confirmed bank file paid ${formatCents(confirmed.totalCents)}, but the run's net pay is ${formatCents(runCents)}`
      + (settlement.owedCents > 0 ? `; ${formatCents(settlement.owedCents)} is still owed` : '')
      + (settlement.overpaidCents > 0 ? `; ${formatCents(settlement.overpaidCents)} was overpaid` : '')
      + '. Settle the difference, then mark it paid with that payment\'s reference and date.');
  }
  if (confirmed.actionDate > today) {
    throw new PayrollRunMarkPaidRefusal('INVALID_PAID_ON',
      `The bank pays this file on ${confirmed.actionDate}: mark the run paid from that day.`);
  }
  return { fileId: confirmed.id, sha256: confirmed.sha256, paidOn: confirmed.actionDate };
}
