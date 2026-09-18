/**
 * Applying a credit note's unused remainder to the contact's open documents.
 *
 * WHAT THIS IS NOT. It posts NO journal: `approveCreditNote` posted the note's
 * journal when it was approved, and the remainder this settles is already on
 * the control account. Applying it moves the subledger only.
 *
 * WHY IT IS GUARDED BY A TABLE CHECK. `credit_note_allocations` — one row per
 * document a note was consumed against — arrives with the credit-note FIFO
 * work, not with this tool. The pre-existing `applyCreditNoteToInvoice` can
 * only spend a whole note against ONE invoice and sets status 'applied'
 * outright, which cannot express a note partly consumed across three bills.
 * So the back-fill writes the allocation rows itself when the table is there
 * and REFUSES the note by name when it is not, rather than half-applying it
 * through a path that would then disagree with `cancel_credit_note`.
 *
 * THE TABLE IS NOT CREATED BY THIS BRANCH. It arrives with the credit-note
 * work's own migration, and a database that has not had that migration takes
 * the refusal path in the orchestrator instead. Everything below was written
 * against the real table as it stands in `isaflow_dev`, not against a guess:
 * `company_id` is NOT NULL on it, and `(credit_note_id, invoice_id)` is UNIQUE,
 * which is what the ON CONFLICT below answers to.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { recomputeInvoiceStatus } from '../ar/invoiceStatusRecompute';
import { EPS, planGreedyAllocations, round2 } from './autoAllocateStrategy';
import type { SimulationDocument } from './autoApplySimulation';
import type { PlannedLine, Subledger } from './autoApplyBackfillPlan';

/**
 * Consume `remainder` across `open` and record it. Returns the lines written,
 * empty when there was nothing open to take it.
 */
export async function applyCreditNoteRemainder(args: {
  companyId: string;
  subledger: Subledger;
  creditNoteId: string;
  remainder: number;
  open: readonly SimulationDocument[];
  userId: string;
}): Promise<PlannedLine[]> {
  const { companyId, subledger, creditNoteId, remainder, open, userId } = args;
  const planned = planGreedyAllocations(remainder, open);
  if (planned.length === 0) return [];

  const kind = subledger === 'ap' ? 'supplier' : 'customer';
  const lines: PlannedLine[] = [];
  for (const line of planned) {
    // ACCUMULATES on conflict rather than replacing. `(credit_note_id,
    // invoice_id)` is UNIQUE, so a note applied to one document twice — a
    // partly consumed note that a later run takes further — has one row whose
    // amount is the total consumed. Replacing it would erase the first
    // application while `applied_amount` still counted it.
    await sql`
      INSERT INTO credit_note_allocations
        (company_id, credit_note_id, invoice_id, amount_allocated)
      VALUES (${companyId}::UUID, ${creditNoteId}::UUID, ${line.invoiceId}::UUID, ${line.amount})
      ON CONFLICT (credit_note_id, invoice_id) DO UPDATE
        SET amount_allocated = credit_note_allocations.amount_allocated + EXCLUDED.amount_allocated
    `;
    if (subledger === 'ap') {
      await sql`
        UPDATE supplier_invoices SET amount_paid = COALESCE(amount_paid, 0) + ${line.amount}
        WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
      `;
    } else {
      await sql`
        UPDATE customer_invoices SET amount_paid = COALESCE(amount_paid, 0) + ${line.amount}
        WHERE id = ${line.invoiceId}::UUID AND company_id = ${companyId}::UUID
      `;
    }
    await recomputeInvoiceStatus(companyId, kind, line.invoiceId);
    lines.push({
      document_id: line.invoiceId,
      document_number: open.find((d) => d.invoiceId === line.invoiceId)?.invoiceNumber ?? '',
      // Filled in by the caller, in one statement for the whole run.
      invoice_date: null,
      amount: line.amount,
    });
  }

  const applied = lines.reduce((s, l) => round2(s + l.amount), 0);
  // `applied_amount` is INCREMENTED, never set: migration 529 exists because a
  // note's recorded application and what the cancel path un-applies must be the
  // same number, and an absolute write would erase an earlier partial.
  await sql`
    UPDATE credit_notes
    SET applied_amount = COALESCE(applied_amount, 0) + ${applied},
        status = CASE
          WHEN COALESCE(applied_amount, 0) + ${applied} >= total_amount - ${EPS}
          THEN 'applied' ELSE 'partially_applied' END,
        updated_at = NOW()
    WHERE id = ${creditNoteId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Back-fill applied credit note remainder', {
    creditNoteId, subledger, lines: lines.length, applied, userId,
  }, 'accounting');
  return lines;
}
