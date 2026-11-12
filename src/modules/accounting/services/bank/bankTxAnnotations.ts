/**
 * The two non-ledger edits a bank line takes from its row: its notes and its analysis dimensions (cc1 / cc2 / BU).
 *
 * Hein, 2026-11-12: a reconciled line is signed off, so its own dimensions cannot be edited from the bank screen —
 * reopen the reconciliation to change them (a Sage-imported reconciled line has none to reopen and stays locked).
 * Notes and supporting documents may still be added: late paperwork is normal and changes no figure.
 *
 * Scope of the lock: reports read the JOURNAL lines' dimensions; the bank-row columns are the line's own tags and a
 * mirror of its journal (gl/dimensions/dimensionBankSync). Retagging a journal (MCP tag_journal_lines,
 * sync_bank_dimensions, reverse_dimension_tag_batch) is the GL's own control — batched, audited, reversible — and its
 * write-through still updates the mirror on a reconciled line, so the bank row never contradicts the journal it shows.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { assertJournalAnalysisDimensions } from '../gl/journalCostCentreValidation';
import { refuseLinesInCompletedSession } from './reconciliationSessionLock';
import { ReconciledCashError } from './reconciledCash';

export interface BankTxDimensions { cc1Id?: string; cc2Id?: string; buId?: string }

/** False when the line is not this company's (the route answers 404); a reconciled line throws ReconciledCashError. */
export async function saveBankTxDimensions(
  companyId: string, bankTxId: string, dims: BankTxDimensions, userId: string,
): Promise<boolean> {
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
    if (!found) return false;
    throw new ReconciledCashError('This line is reconciled, so its cost centre and business unit are locked. '
      + 'Reopen its bank reconciliation to change them (a line reconciled in the Sage import cannot be changed here).');
  }
  log.info('Saved bank transaction dimensions', { bankTxId, userId, ...dims }, 'accounting');
  return true;
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
