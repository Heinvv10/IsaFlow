/**
 * Provisional-Entry Dismiss Service (A–Z P3.5)
 *
 * Dismissing a provisional bank-posted JE must UNDO it, not just close a
 * modal: the June audit found "Dismiss" showed an "automatic reversal is not
 * yet implemented" toast and left the journal posted forever.
 *
 * The reversal goes through `reverseProvisionalEntry` — the controlled reversal
 * of the allocation that owns the journal, under its approval policy. A direct
 * reverseJournalEntry here was refused (the journal carries a generated source)
 * and the refusal poisoned the request, so dismiss answered 500 for every
 * provisional entry. The controlled reversal posts the contra AND returns the
 * bank transaction to the review queue, so the reset is no longer done here.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { reverseProvisionalEntry } from './bankAllocationService';

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

  const reversal = await reverseProvisionalEntry(companyId, jeId, userId, { reason: 'Provisional entry dismissed' });

  log.info(
    'Provisional entry dismissed (reversed)',
    { companyId, jeId, reversalId: reversal.reversalJournalEntryId, bankTransactionId: reversal.bankTransactionId },
    'provisional-dismiss',
  );

  return {
    reversalJournalEntryId: reversal.reversalJournalEntryId,
    bankTransactionsReset: 1,
  };
}
