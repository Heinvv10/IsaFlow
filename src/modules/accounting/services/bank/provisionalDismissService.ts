/**
 * Provisional-Entry Dismiss Service (A–Z P3.5)
 *
 * Dismissing a provisional bank-posted JE must UNDO it, not just close a
 * modal: the June audit found "Dismiss" showed an "automatic reversal is not
 * yet implemented" toast and left the journal posted forever. This reuses
 * the exact reversal + bank-txn-reset plumbing from autoPostUndoService:
 * reverseJournalEntry posts a net-zero contra (reversed_at metadata
 * semantics), then any bank transaction pointing at the JE returns to the
 * review queue (status 'imported', provisional link cleared).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { reverseJournalEntry } from '../gl/journalEntryService';

type Row = DbRow;

export interface DismissResult {
  reversalJournalEntryId: string;
  bankTransactionsReset: number;
}

export async function dismissProvisionalEntry(
  companyId: string,
  jeId: string,
  userId: string,
): Promise<DismissResult> {
  const jeRows = (await sql`
    SELECT id, needs_evidence, status FROM gl_journal_entries
    WHERE id = ${jeId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as Row[];
  if (jeRows.length === 0) throw new Error(`Journal entry ${jeId} not found`);
  if (!jeRows[0]!.needs_evidence) {
    throw new Error('Journal entry is not provisional — dismiss only applies to provisional entries');
  }

  const reversal = await reverseJournalEntry(companyId, jeId, userId);

  const resetRows = (await sql`
    UPDATE bank_transactions
    SET status = 'imported', provisional_je_id = NULL, updated_at = NOW()
    WHERE provisional_je_id = ${jeId}::UUID AND company_id = ${companyId}::UUID
    RETURNING id
  `) as Row[];

  log.info(
    'Provisional entry dismissed (reversed)',
    { companyId, jeId, reversalId: reversal.id, bankTransactionsReset: resetRows.length },
    'provisional-dismiss',
  );

  return {
    reversalJournalEntryId: String(reversal.id),
    bankTransactionsReset: resetRows.length,
  };
}
