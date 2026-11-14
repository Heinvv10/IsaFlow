/**
 * Give back everything a credit note applied, and delete the rows that
 * recorded it — the cancel path's half of `credit_note_allocations`.
 *
 * Split from creditNoteFifo.ts (300-line cap). Returns the documents restored
 * and what their `amount_paid` measurably moved by, which the cancel checks
 * against the note's applied amount (`creditNoteApplicationInvariant`). A note
 * approved before migration 677 has no rows, so the caller falls back to its
 * single link — see creditNoteCancelService.
 */
import { sql } from '@/lib/neon';
import { round2 } from './autoAllocateStrategy';
import { listCreditNoteAllocations, type CreditNoteApplicationLine, type CreditNoteSide } from './creditNoteFifo';
import { assertAllocationsMatchApplied, lockInvoicesForUpdate, undoApplication } from './creditNoteApplicationWrites';

export async function reverseCreditNoteApplications(
  companyId: string,
  creditNoteId: string,
  side: CreditNoteSide,
  /** `credit_notes.applied_amount`, checked against the rows before anything moves. */
  appliedAmount: number,
): Promise<{ lines: CreditNoteApplicationLine[]; paidMoved: number }> {
  const lines = await listCreditNoteAllocations(companyId, creditNoteId);
  if (lines.length === 0) return { lines, paidMoved: 0 };

  // Refuses a note whose column and rows disagree — restoring only the rows
  // would leave the rest of `applied_amount` credited to a document nothing
  // names. Same guard, same reasoning, as on the way in.
  // A take-back: the one-cent tolerance, so a note already a cent apart can still be cancelled (and ends at 0 / 0).
  await assertAllocationsMatchApplied(companyId, creditNoteId, appliedAmount, 'decrease');

  // Locked in id order, in ONE statement, exactly as the apply path takes them.
  await lockInvoicesForUpdate('cancelCreditNote', companyId, side, lines.map((l) => l.invoiceId));

  let paidMoved = 0;
  for (const line of lines) {
    paidMoved = round2(paidMoved + await undoApplication(companyId, creditNoteId, side, line));
  }

  await sql`
    DELETE FROM credit_note_allocations
    WHERE credit_note_id = ${creditNoteId}::UUID AND company_id = ${companyId}::UUID
  `;
  return { lines, paidMoved };
}
