/**
 * K-053: the GL side of soft-deleting an invoice.
 *
 * Approving a customer invoice or a supplier bill posts a journal, and
 * CANCELLING one reverses it (customerInvoiceCancelService,
 * supplierInvoiceWorkflowService.cancelSupplierInvoice) precisely so the ledger
 * stops carrying a document the subledger no longer shows. Soft-delete only
 * ever set deleted_at, so once aging and the subledger exclude the deleted
 * document its debit stays on the control account and the two stop tying.
 *
 * Soft-delete is UNDOABLE, so unlike cancel this has to work in both
 * directions. The link column is left pointing at the ORIGINAL entry and the
 * journal itself carries the state: reversing entry O posts R with
 * reversal_of_id = O and stamps O.reversed_at, reversing R posts R2, and so on.
 * The chain is linear, exactly one entry in it is un-reversed (the head), and
 * the document's GL is live when that head sits at an ODD depth. Deleting
 * reverses a live head; restoring reverses a dead one. No extra column, and
 * every step is an ordinary auditable reversal.
 *
 * The caller runs inside the request transaction and inside a SAVEPOINT — a
 * refusal here (a closed fiscal period is the realistic one) must roll the
 * reversal's draft INSERTs back rather than orphan-commit them on the 4xx.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { reverseJournalEntry } from '../gl/journalEntryPostingService';

/** Amounts below this (in currency units) are treated as zero, as in cancel. */
const ZERO_TOLERANCE = 0.005;

/** The un-reversed entry of a document's reversal chain, and whether it is live. */
async function chainHead(
  companyId: string,
  rootJournalEntryId: string,
): Promise<{ id: string; live: boolean } | null> {
  const rows = (await sql`
    WITH RECURSIVE chain AS (
      SELECT id, reversed_at, 1 AS depth
      FROM gl_journal_entries
      WHERE id = ${rootJournalEntryId}::UUID AND company_id = ${companyId}::UUID
        AND status = 'posted'
      UNION ALL
      SELECT j.id, j.reversed_at, chain.depth + 1
      FROM gl_journal_entries j
      JOIN chain ON j.reversal_of_id = chain.id
      WHERE j.company_id = ${companyId}::UUID AND j.status = 'posted'
    )
    SELECT id, depth FROM chain WHERE reversed_at IS NULL
  `) as DbRow[];
  if (rows.length !== 1) return null;
  return { id: String(rows[0]!.id), live: Number(rows[0]!.depth) % 2 === 1 };
}

/**
 * Take the document's journal out of the ledger before it is soft-deleted.
 * A document with no journal, or one already reversed, is a no-op. Returns the
 * id of the reversal entry posted, or null.
 */
export async function reverseDocumentJournalForDelete(
  companyId: string,
  journalEntryId: string | null,
  userId: string,
): Promise<string | null> {
  if (!journalEntryId) return null;
  const head = await chainHead(companyId, journalEntryId);
  if (!head || !head.live) return null;
  const reversal = await reverseJournalEntry(companyId, head.id, userId);
  return reversal.id;
}

/**
 * Put it back when the delete is undone. The mirror of the above: reversing the
 * dead head re-instates the original amounts, so the restored document is once
 * again backed by the ledger. A document whose journal is already live — it was
 * never reversed by a delete — is a no-op, which is what stops an undo from
 * inventing a journal for an invoice that never had one.
 */
export async function reinstateDocumentJournalForUndo(
  companyId: string,
  journalEntryId: string | null,
  userId: string,
): Promise<string | null> {
  if (!journalEntryId) return null;
  const head = await chainHead(companyId, journalEntryId);
  if (!head || head.live) return null;
  const reinstated = await reverseJournalEntry(companyId, head.id, userId);
  return reinstated.id;
}


/**
 * Lock the invoice for this request transaction and read what the delete
 * decides on. FOR UPDATE for the same reason cancel takes it: two concurrent
 * deletes must not both pass the guards and double-reverse the journal.
 */
async function lockInvoice(
  entityType: string,
  entityId: string,
  companyId: string,
): Promise<DbRow | null> {
  const rows = (entityType === 'customer_invoice'
    ? await sql`
        SELECT status, amount_paid, gl_journal_entry_id, deleted_at
        FROM customer_invoices
        WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID
        FOR UPDATE
      `
    : await sql`
        SELECT status, amount_paid, gl_journal_entry_id, deleted_at
        FROM supplier_invoices
        WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID
        FOR UPDATE
      `) as DbRow[];
  return rows.length > 0 ? rows[0]! : null;
}

/**
 * Guards and GL work for soft-deleting an invoice, run before deleted_at is
 * set. Refuses a posted document, a document carrying payments (cancel refuses
 * the same, and here it also stops the supplier ledger from showing a payment
 * whose bill has been hidden), and — by letting reverseJournalEntry throw —
 * one whose journal cannot be reversed into an open period.
 */
export async function prepareInvoiceDelete(
  entityType: string,
  entityId: string,
  companyId: string,
  userId: string,
): Promise<{ reversalJournalEntryId: string | null }> {
  const row = await lockInvoice(entityType, entityId, companyId);
  if (!row || row.deleted_at != null) {
    throw new Error(`${entityType} not found or already deleted`);
  }
  if (String(row.status) === 'posted') {
    throw new Error(`Cannot delete a posted ${entityType}`);
  }
  if (Number(row.amount_paid ?? 0) > ZERO_TOLERANCE) {
    throw new Error(`Cannot delete a ${entityType} with payments`);
  }
  const reversalJournalEntryId = await reverseDocumentJournalForDelete(
    companyId,
    row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : null,
    userId,
  );
  return { reversalJournalEntryId };
}

/** The mirror, run after the restore has cleared deleted_at. */
export async function reinstateInvoiceJournal(
  entityType: string,
  entityId: string,
  companyId: string,
  userId: string,
): Promise<string | null> {
  const row = await lockInvoice(entityType, entityId, companyId);
  if (!row) return null;
  return reinstateDocumentJournalForUndo(
    companyId,
    row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : null,
    userId,
  );
}
