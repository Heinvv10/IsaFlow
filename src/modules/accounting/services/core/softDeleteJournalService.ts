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
 * directions, and the undo must put back EXACTLY what the delete took out.
 * Round 2 inferred that from the reversal chain — reverse a live head on
 * delete, reverse a dead one on undo — which cannot tell "dead because this
 * delete killed it" from "dead because a user reversed it from the GL screen".
 * In the second case the undo posted a fresh journal re-instating revenue and
 * VAT output somebody had deliberately reversed, dated back into a closed VAT
 * period. So the reversal id is now RECORDED (soft_delete_journal_reversals,
 * migration 645) and the undo reverses that row's entry or nothing at all.
 *
 * The caller runs inside the request transaction and inside a SAVEPOINT — a
 * refusal here (a closed fiscal period is the realistic one) must roll the
 * reversal's draft INSERTs back rather than orphan-commit them on the 4xx.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { reverseJournalEntry } from '../gl/journalEntryPostingService';
import { assertInvoiceDeletable } from './softDeleteInvoiceGuards';

/**
 * Lock the document's journal entry and report whether it is still live.
 * FOR UPDATE for the reason both cancel paths take it: a concurrent reversal
 * from the GL screen landing between this read and reverseJournalEntry makes
 * the reversal throw "already reversed" and the route answer 500. The invoice
 * row lock does not cover it — that writer never touches the invoice.
 */
async function lockJournalEntry(
  companyId: string,
  journalEntryId: string,
): Promise<{ status: string; reversedAt: unknown } | null> {
  const rows = (await sql`
    SELECT status, reversed_at
    FROM gl_journal_entries
    WHERE id = ${journalEntryId}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `) as DbRow[];
  if (rows.length === 0) return null;
  return { status: String(rows[0]!.status), reversedAt: rows[0]!.reversed_at };
}

/**
 * The one un-reversed entry of the document's reversal chain, and whether that
 * chain is currently STANDING in the ledger.
 *
 * The link column always points at the ORIGINAL entry, and reversing is
 * additive: reversing O posts R with reversal_of_id = O, reversing R posts R2,
 * and so on. So the chain is linear, exactly one entry in it is un-reversed,
 * and the document's journal is standing when that head sits at an ODD depth.
 * Reading the linked entry's own reversed_at is NOT enough — after one
 * delete/undo round trip the original is permanently marked reversed while the
 * chain nets back to standing, and a second delete would then wrongly conclude
 * there was nothing to take out of the ledger.
 */
async function chainHead(
  companyId: string,
  rootJournalEntryId: string,
): Promise<{ id: string; standing: boolean }> {
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
  if (rows.length !== 1) {
    // Every other guard in this file throws, and this one must too: skipping
    // here soft-deletes the document with its journal left standing, which is
    // the exact defect this service exists to prevent, with nothing in the
    // response, the log or the audit trail to say so.
    throw new Error(
      `Journal entry ${rootJournalEntryId} has an unexpected reversal chain ` +
        `(${rows.length} un-reversed entries); refusing to delete this document`,
    );
  }
  return { id: String(rows[0]!.id), standing: Number(rows[0]!.depth) % 2 === 1 };
}

/**
 * Take the document's journal out of the ledger before it is soft-deleted, and
 * return the id of the reversal posted, or null when there was nothing to
 * reverse. Nothing to reverse is a real, ordinary case — a draft invoice never
 * posted one, and a journal already reversed from the GL screen is already out
 * of the ledger — but a link pointing at an entry this company cannot see is
 * not, and is raised rather than skipped.
 */
async function reverseDocumentJournalForDelete(
  companyId: string,
  journalEntryId: string | null,
  userId: string,
): Promise<string | null> {
  if (!journalEntryId) return null;
  const linked = await lockJournalEntry(companyId, journalEntryId);
  if (!linked) {
    // A link the company cannot reach means the GL cannot be reasoned about at
    // all, and silently deleting the document would leave exactly the untied
    // ledger this whole change exists to prevent.
    throw new Error(
      `Journal entry ${journalEntryId} linked to this document does not exist in this company`,
    );
  }
  if (linked.status !== 'posted') {
    // A draft journal is not in the ledger, so there is nothing to take out.
    log.info(
      'Soft delete — linked journal is not posted, nothing to reverse',
      { companyId, journalEntryId, status: linked.status },
      'accounting',
    );
    return null;
  }

  const head = await chainHead(companyId, journalEntryId);
  if (!head.standing) {
    log.info(
      'Soft delete — the document journal is already out of the ledger, nothing to reverse',
      { companyId, journalEntryId, headId: head.id },
      'accounting',
    );
    return null;
  }
  // Lock the entry actually being reversed, not only the linked original: a
  // concurrent reversal from the GL screen landing between the read and
  // reverseJournalEntry makes that call throw "already reversed" and the route
  // answer 500. Both cancel paths take the same lock.
  const locked = await lockJournalEntry(companyId, head.id);
  if (!locked || locked.status !== 'posted' || locked.reversedAt != null) {
    log.info(
      'Soft delete — the chain head was reversed concurrently, nothing to reverse',
      { companyId, journalEntryId, headId: head.id },
      'accounting',
    );
    return null;
  }
  const reversal = await reverseJournalEntry(companyId, head.id, userId);
  return reversal.id;
}

/**
 * Guards and GL work for soft-deleting an invoice, run before deleted_at is
 * set. Refuses a posted document, a document carrying settlement (paid or
 * merely allocated), and — by letting reverseJournalEntry throw — one whose
 * journal cannot be reversed into an open period. Records the reversal it
 * posts so the undo can reverse exactly that entry.
 */
export async function prepareInvoiceDelete(
  entityType: string,
  entityId: string,
  companyId: string,
  userId: string,
): Promise<{ reversalJournalEntryId: string | null }> {
  const row = await assertInvoiceDeletable(entityType, entityId, companyId);

  const reversalJournalEntryId = await reverseDocumentJournalForDelete(
    companyId,
    row.gl_journal_entry_id ? String(row.gl_journal_entry_id) : null,
    userId,
  );
  if (reversalJournalEntryId) {
    // ON CONFLICT because a document can be deleted, undone and deleted again;
    // the row describes the CURRENT delete, and the undo removes it.
    await sql`
      INSERT INTO soft_delete_journal_reversals
        (company_id, entity_type, entity_id, reversal_journal_entry_id, created_by)
      VALUES (${companyId}::UUID, ${entityType}, ${entityId}::UUID,
              ${reversalJournalEntryId}::UUID, ${userId})
      ON CONFLICT (company_id, entity_type, entity_id) DO UPDATE
        SET reversal_journal_entry_id = EXCLUDED.reversal_journal_entry_id,
            created_by = EXCLUDED.created_by,
            created_at = NOW()
    `;
  }
  return { reversalJournalEntryId };
}

/**
 * Put back exactly what the delete took out, run after the restore has cleared
 * deleted_at. No recorded reversal means the delete posted nothing — a draft
 * invoice, or one whose journal a user had already reversed — and the undo
 * must post nothing either, which is what stops it from re-instating a
 * correction somebody made deliberately.
 */
export async function reinstateInvoiceJournal(
  entityType: string,
  entityId: string,
  companyId: string,
  userId: string,
): Promise<string | null> {
  const rows = (await sql`
    DELETE FROM soft_delete_journal_reversals
    WHERE company_id = ${companyId}::UUID
      AND entity_type = ${entityType}
      AND entity_id = ${entityId}::UUID
    RETURNING reversal_journal_entry_id
  `) as DbRow[];
  if (rows.length === 0) return null;

  const reversalId = String(rows[0]!.reversal_journal_entry_id);
  const entry = await lockJournalEntry(companyId, reversalId);
  if (!entry) {
    throw new Error(`Reversal entry ${reversalId} recorded for this delete does not exist`);
  }
  if (entry.status !== 'posted' || entry.reversedAt != null) {
    // Somebody reversed our reversal by hand between the delete and the undo.
    // The ledger is already back where the undo wanted it, so re-instating
    // again would DOUBLE the document.
    log.warn(
      'Undo delete — the delete reversal was already reversed elsewhere, not re-instating',
      { companyId, entityType, entityId, reversalId, status: entry.status },
      'accounting',
    );
    return null;
  }
  const reinstated = await reverseJournalEntry(companyId, reversalId, userId);
  return reinstated.id;
}
