/**
 * Credit-note DELETE — the removal of a DRAFT note that never posted.
 *
 * The app has no draft-credit-note delete: `credit_notes` has no `deleted_at`, the soft-delete service does not
 * list it, and the supplier note page's Delete button posts `cancel`, which refuses a draft. This is therefore a
 * HARD delete, taken under the same row lock approve and cancel take (`lockCreditNoteForUpdate`), with the status
 * re-read inside it: a concurrent `approve_credit_note` either holds the row first (this waits, then sees
 * `approved` and refuses) or waits behind this (and finds the note gone).
 *
 * A draft numbered from the supplier return sequence (anything but the trigger's CN-<year>-<n>, or anything starting
 * with the company's current supplier_return prefix) is refused: its
 * number came off a sequential series and a hard delete would leave a permanent gap. The delete writes an
 * `audit_log` row ('delete', entity_type 'credit_note', the note's values) in the same transaction.
 *
 * Every refusal is raised BEFORE the first write, as a `CreditNoteDeleteRefusal`; once the attachment update has
 * run, a failure is a plain throw so the caller's savepoint unwinds both statements.
 *
 * What references a credit note (census on a migrated cluster, `pg_constraint` + a code search):
 *   FK, ON DELETE CASCADE: credit_note_allocations, credit_note_revenue_allocations,
 *     credit_note_expense_allocations. A draft has none (they are written at approve), so any row is corrupt state
 *     and is refused rather than silently cascaded.
 *   No FK: customer_invoice_disputes.credit_note_id (refused: dispute resolution owns that note), approval_requests
 *     (document_id; a PENDING request is refused, decided ones stay as the approval history), procurement_documents
 *     (entity_type 'credit_note': attachments are DETACHED with is_active = false, as the Documents API detaches
 *     one; the file row stays).
 *   Columns on the row itself, gone with it: external_ref / external_document_number / external_system, the actor
 *   stamps, the dimension tags, gl_account_id. credit_notes.gl_journal_entry_id must be NULL on a draft.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { log } from '@/lib/logger';
import { logAuditOrThrow, type AuditFieldChange } from '../core/auditTrailService';
import { getDocumentNumbers } from '../core/companySettingsService';
import { lockCreditNoteForUpdate } from './creditNoteLock';

export type CreditNoteDeleteRefusalCode =
  | 'NOT_FOUND' | 'NOT_DRAFT' | 'OWN_SEQUENCE' | 'HAS_JOURNAL' | 'HAS_APPLICATIONS' | 'DISPUTE_NOTE' | 'APPROVAL_PENDING';

/** A refusal written for the caller; always raised before any write. */
export class CreditNoteDeleteRefusal extends Error {
  constructor(readonly code: CreditNoteDeleteRefusalCode, message: string) {
    super(message);
    this.name = 'CreditNoteDeleteRefusal';
  }
}

export interface DeletedCreditNote {
  id: string;
  creditNoteNumber: string;
  type: 'customer' | 'supplier';
  creditDate: string;
  subtotal: number;
  taxRate: number;
  taxAmount: number;
  totalAmount: number;
  reason: string | null;
  clientId: string | null;
  supplierId: string | null;
  customerInvoiceId: string | null;
  supplierInvoiceId: string | null;
  glAccountId: string | null;
  externalRef: string | null;
  externalDocumentNumber: string | null;
  externalSystem: string | null;
  /** Attachment links deactivated (procurement_documents.is_active = false). */
  attachmentsDetached: number;
}

/**
 * The numbers the credit-note trigger issues (`generate_credit_note_number`: CN-<year>-<highest + 1>). A note numbered
 * any other way came off a document-number SEQUENCE: the only such writer is `supplier-returns.ts`, which reserves
 * `reserveNextDocumentNumber(companyId, 'supplier_return')` (prefix and format are the company's setting) and links
 * nothing else on the row. Deleting one would leave a permanent gap in that sequential series.
 */
const CREDIT_NOTE_SERIES = /^CN-\d{4}-\d+$/;

/**
 * The company's CURRENT `supplier_return` prefix (a free-text setting). A prefix such as "CN-2026-" makes a return
 * look like a trigger number, so the series test alone is not enough. Company-scoped read, in the delete's
 * transaction. Empty when unset or blank: every note would otherwise match.
 * LIMIT: a return numbered under an EARLIER prefix that looks like CN-<year>-<n> is not recognised.
 */
async function supplierReturnPrefix(companyId: string): Promise<string> {
  const rows = await getDocumentNumbers(companyId);
  return rows.find((d) => d.documentType === 'supplier_return')?.prefix.trim() ?? '';
}

const APPROVAL_TYPES = ['customer_credit_note', 'supplier_credit_note', 'credit_note'];

const str = (v: unknown): string | null => (v == null ? null : String(v));

function notDraftMessage(number: string, status: string): string {
  if (status === 'cancelled') {
    return `Credit note ${number} is already cancelled: a cancelled note stays on the books as the record of its reversal and cannot be deleted.`;
  }
  return `Credit note ${number} is ${status}: only a draft can be deleted. `
    + 'Use cancel_credit_note to reverse it (needs the write:post permission).';
}

/** Reads that must all come back empty for a draft; each hit is a refusal. */
async function assertNothingHoldsTheNote(companyId: string, id: string, number: string, cn: DbRow): Promise<void> {
  if (cn.gl_journal_entry_id) {
    throw new CreditNoteDeleteRefusal('HAS_JOURNAL',
      `Credit note ${number} is a draft but carries a ledger journal (${String(cn.gl_journal_entry_id)}). `
      + 'That is inconsistent data and it was not deleted: report it so it can be repaired.');
  }
  const [alloc] = (await sql`
    SELECT
      (SELECT COUNT(*) FROM credit_note_allocations WHERE credit_note_id = ${id}::UUID AND company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM credit_note_revenue_allocations WHERE credit_note_id = ${id}::UUID AND company_id = ${companyId}::UUID)
      + (SELECT COUNT(*) FROM credit_note_expense_allocations WHERE credit_note_id = ${id}::UUID AND company_id = ${companyId}::UUID)
      AS n
  `) as DbRow[];
  if (Number(alloc?.n ?? 0) > 0 || Number(cn.applied_amount ?? 0) !== 0) {
    throw new CreditNoteDeleteRefusal('HAS_APPLICATIONS',
      `Credit note ${number} is a draft but already has credit applied or allocated. `
      + 'That is inconsistent data and it was not deleted: report it so it can be repaired.');
  }
  const [dispute] = (await sql`
    SELECT id FROM customer_invoice_disputes
    WHERE credit_note_id = ${id}::UUID AND company_id = ${companyId}::UUID LIMIT 1
  `) as DbRow[];
  if (dispute) {
    throw new CreditNoteDeleteRefusal('DISPUTE_NOTE',
      `Credit note ${number} was raised by resolving a dispute and the dispute still points at it, `
      + 'so it cannot be deleted here. Approve it, or deal with the dispute in the app.');
  }
  const [pending] = (await sql`
    SELECT id FROM approval_requests
    WHERE document_id = ${id}::UUID AND company_id = ${companyId}::UUID
      AND document_type = ANY(${APPROVAL_TYPES}::TEXT[]) AND status = 'pending' LIMIT 1
  `) as DbRow[];
  if (pending) {
    throw new CreditNoteDeleteRefusal('APPROVAL_PENDING',
      `Credit note ${number} has a pending approval request. Reject or withdraw the request first, then delete the draft.`);
  }
}

export async function deleteDraftCreditNote(companyId: string, id: string, userId: string): Promise<DeletedCreditNote> {
  // Locked FOR UPDATE for the rest of the request transaction, status read INSIDE the lock. A peer holding the row
  // past the 5 s budget throws CreditNoteLockTimeoutError ("retry in a moment") before any write.
  const cn = await lockCreditNoteForUpdate(companyId, id);
  if (!cn) throw new CreditNoteDeleteRefusal('NOT_FOUND', 'Not found');
  const number = String(cn.credit_note_number ?? id);
  const status = String(cn.status);
  if (status !== 'draft') throw new CreditNoteDeleteRefusal('NOT_DRAFT', notDraftMessage(number, status));
  const returnPrefix = await supplierReturnPrefix(companyId);
  if (!CREDIT_NOTE_SERIES.test(number) || (returnPrefix !== '' && number.startsWith(returnPrefix))) {
    throw new CreditNoteDeleteRefusal('OWN_SEQUENCE',
      `Credit note ${number} was numbered from the supplier return sequence, not the credit-note series, so deleting it `
      + 'would leave a permanent gap in that sequence. It cannot be deleted. Leave it as a draft, or approve it and then '
      + 'cancel it with cancel_credit_note (needs write:post), which keeps the number on the books.');
  }
  await assertNothingHoldsTheNote(companyId, id, number, cn);

  // Detached BEFORE the delete: procurement_documents' policy for a credit_note row asks for the parent to exist.
  const detached = (await sql`
    UPDATE procurement_documents SET is_active = false
    WHERE entity_type = 'credit_note' AND entity_id = ${id}::UUID AND is_active = true
    RETURNING id
  `) as DbRow[];

  const gone = (await sql`
    DELETE FROM credit_notes
    WHERE id = ${id}::UUID AND company_id = ${companyId}::UUID AND status = 'draft'
    RETURNING id
  `) as DbRow[];
  if (gone.length !== 1) throw new Error(`Credit note ${id} vanished while being deleted.`);

  const result: DeletedCreditNote = {
    id,
    creditNoteNumber: number,
    type: String(cn.type) as DeletedCreditNote['type'],
    creditDate: fmtDate(cn.credit_date),
    subtotal: Number(cn.subtotal),
    taxRate: Number(cn.tax_rate),
    taxAmount: Number(cn.tax_amount),
    totalAmount: Number(cn.total_amount),
    reason: str(cn.reason),
    clientId: str(cn.client_id),
    supplierId: str(cn.supplier_id),
    customerInvoiceId: str(cn.customer_invoice_id),
    supplierInvoiceId: str(cn.supplier_invoice_id),
    glAccountId: str(cn.gl_account_id),
    externalRef: str(cn.external_ref),
    externalDocumentNumber: str(cn.external_document_number),
    externalSystem: str(cn.external_system),
    attachmentsDetached: detached.length,
  };
  // The record of what was removed, in the SAME transaction (append-only audit_log): a rollback takes both, a dry
  // run's rolled-back savepoint leaves neither. The registry's mcp_tool_calls row also carries the tool result, but
  // only as an idempotency record and not where a reviewer of the document looks.
  await logAuditOrThrow({
    companyId, userId, action: 'delete', entityType: 'credit_note', entityId: id, entityRef: number,
    changes: { fields: auditFields(result), metadata: { source: 'mcp:delete_draft_credit_note', attachments_detached: String(detached.length) } },
  });
  log.info('Deleted draft credit note', { id, number, attachmentsDetached: detached.length }, 'accounting');
  return result;
}

function auditFields(n: DeletedCreditNote): AuditFieldChange[] {
  const rows: Array<[string, string | number | null]> = [
    ['credit_note_number', n.creditNoteNumber], ['type', n.type], ['status', 'draft'], ['credit_date', n.creditDate],
    ['subtotal', n.subtotal], ['tax_rate', n.taxRate], ['tax_amount', n.taxAmount], ['total_amount', n.totalAmount],
    ['reason', n.reason], ['client_id', n.clientId], ['supplier_id', n.supplierId],
    ['customer_invoice_id', n.customerInvoiceId], ['supplier_invoice_id', n.supplierInvoiceId],
    ['gl_account_id', n.glAccountId], ['external_ref', n.externalRef],
    ['external_document_number', n.externalDocumentNumber], ['external_system', n.externalSystem],
  ];
  return rows.map(([field, v]) => ({ field, old: v == null ? null : String(v), new: null, label: field }));
}
