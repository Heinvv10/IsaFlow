/**
 * The two non-ledger edits a bank line takes from its row: its notes and its analysis dimensions (cc1 / cc2 / BU).
 *
 * Hein, 2026-11-12: a reconciled line is signed off. Its dimensions feed reporting, so they lock with it — reopen
 * the reconciliation to change them (a Sage-imported reconciled line has none to reopen and stays locked). Notes and
 * supporting documents may still be added to a reconciled line: late paperwork is normal and changes no figure.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertJournalAnalysisDimensions } from '../gl/journalCostCentreValidation';
import { refuseLinesInCompletedSession } from './reconciliationSessionLock';
import { ReconciledCashError } from './reconciledCash';

export interface BankTxDimensions { cc1Id?: string; cc2Id?: string; buId?: string }

export async function saveBankTxDimensions(
  companyId: string, bankTxId: string, dims: BankTxDimensions, userId: string,
): Promise<void> {
  await assertJournalAnalysisDimensions(companyId, [dims]);
  await refuseLinesInCompletedSession(companyId, [bankTxId]); // D12: in a completed session -> the shared 409
  const rows = (await sql`
    UPDATE bank_transactions
    SET cc1_id = ${dims.cc1Id || null}::UUID,
        cc2_id = ${dims.cc2Id || null}::UUID,
        bu_id = ${dims.buId || null}::UUID,
        updated_at = NOW()
    WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID AND status <> 'reconciled'
    RETURNING id`) as Array<{ id: string }>;
  if (rows.length === 0) {
    const [found] = (await sql`
      SELECT status FROM bank_transactions WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
    `) as Array<{ status: string }>;
    if (!found) throw new Error(`Bank transaction ${bankTxId} not found`);
    throw new ReconciledCashError('This line is reconciled, so its cost centre and business unit are locked. '
      + 'Reopen its bank reconciliation to change them (a line reconciled in the Sage import cannot be changed here).');
  }
  log.info('Saved bank transaction dimensions', { bankTxId, userId, ...dims }, 'accounting');
}

export async function updateBankTxNotes(
  companyId: string, bankTxId: string, notes: string | undefined, userId: string,
): Promise<void> {
  const rows = (await sql`
    UPDATE bank_transactions SET notes = ${notes || null}, updated_at = NOW()
    WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID
    RETURNING status`) as Array<{ status: string }>;
  log.info('Updated bank transaction notes', { bankTxId, userId, status: rows[0]?.status }, 'accounting');
}

export const RECONCILED_DOCUMENT_REMOVAL =
  'This line is reconciled, so its supporting documents cannot be removed. You can still add documents; '
  + 'reopen its bank reconciliation to remove one.';

/**
 * Is the line (named directly, or through one of its attachments) reconciled? Read FOR SHARE so a completion
 * cannot reconcile it between this answer and the caller's removal. Adding a document needs no check.
 */
export async function isReconciledLine(
  companyId: string, ref: { bankTxId: string } | { attachmentId: string },
): Promise<boolean> {
  const rows = ('bankTxId' in ref
    ? await sql`
      SELECT bt.status FROM bank_transactions bt
      WHERE bt.id = ${ref.bankTxId}::UUID AND bt.company_id = ${companyId}::UUID
      FOR SHARE OF bt`
    : await sql`
      SELECT bt.status FROM bank_transaction_attachments bta
      JOIN bank_transactions bt ON bt.id = bta.bank_transaction_id AND bt.company_id = ${companyId}::UUID
      WHERE bta.id = ${ref.attachmentId}::UUID
      FOR SHARE OF bt`) as Array<{ status: string }>;
  return rows[0]?.status === 'reconciled';
}
