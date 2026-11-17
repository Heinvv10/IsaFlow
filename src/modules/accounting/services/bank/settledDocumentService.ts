/**
 * The settled-document evidence of ONE bank line (bank/settledDocumentSql): the documents of the bills, invoices and
 * offsetting credit notes its payment settles. Read-only: nothing is copied and no row is written.
 *
 * Tenant scope: the line is read by id AND company_id, and every join in the fragment re-checks the line's company.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { settledDocumentsSql } from './settledDocumentSql';
import { capturedDocUsableSql } from './bankLineDocumentSql';
import { SETTLING_LINE_STATUSES } from '../core/paymentVoidReads';
import { mimeForCapturedFileType } from '../capture/capturedFileTypes';
import { capturedFileUrl } from '../capture/capturedAttachmentLinks';

/** One line settles a bounded set of bills; this is the guard against a pathological one. */
export const SETTLED_DOCUMENTS_MAX = 200;

export interface SettledDocument {
  source: 'settled_document';
  /** procurement_documents id ('entity') or captured_documents id ('captured'). */
  documentId: string;
  store: 'entity' | 'captured';
  fileName: string;
  mimeType: string | null;
  fileSize: number | null;
  /** The stored link of an entity document; for a captured document, the captured-document-file route. */
  fileUrl: string | null;
  createdAt: string;
  /** The payment the line went through. */
  via: { kind: 'supplier_payment' | 'customer_payment'; paymentId: string; paymentNumber: string | null };
  /** What the document belongs to and what this line's payment applied to it. */
  settles: {
    entityType: 'supplier_invoice' | 'customer_invoice' | 'credit_note';
    entityId: string;
    number: string | null;
    /** The bill / invoice / credit note's own total. */
    total: number;
    /** Paid by this payment (a credit note: the credit it applied to the invoice). */
    applied: number;
    /** A bill / invoice this payment paid only part of. Never set for a credit note. */
    partial: boolean;
    /** For a credit note: the bill / invoice it offsets. */
    invoiceId: string;
    invoiceNumber: string | null;
  };
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const str = (v: unknown): string | null => (v == null ? null : String(v));

export function mapSettledDocument(r: DbRow): SettledDocument {
  const entityType = String(r.entity_type) as SettledDocument['settles']['entityType'];
  const total = Number(r.entity_total ?? 0);
  const applied = Number(r.applied ?? 0);
  const captured = String(r.store) === 'captured';
  return {
    source: 'settled_document',
    documentId: String(r.document_id),
    store: captured ? 'captured' : 'entity',
    fileName: String(r.file_name ?? ''),
    mimeType: captured ? (r.mime_type ? mimeForCapturedFileType(String(r.mime_type)) : null) : str(r.mime_type),
    fileSize: r.file_size == null ? null : Number(r.file_size),
    fileUrl: captured ? capturedFileUrl(String(r.document_id)) : str(r.file_url),
    createdAt: iso(r.created_at),
    via: {
      kind: String(r.payment_kind) as SettledDocument['via']['kind'],
      paymentId: String(r.payment_id),
      paymentNumber: str(r.payment_number),
    },
    settles: {
      entityType,
      entityId: String(r.entity_id),
      number: str(r.entity_number),
      total,
      applied,
      partial: entityType !== 'credit_note' && applied < total,
      invoiceId: String(r.settles_invoice_id),
      invoiceNumber: str(r.settles_number),
    },
  };
}

/**
 * The line's settled documents, bills first by number then credit notes; one row per (document, settled entity,
 * payment). An unallocated line, a line coded to an expense account and a payment with no applications all return [].
 * A foreign or unknown line returns [] too — the caller checks ownership first when it must tell the two apart.
 */
export async function listSettledDocuments(companyId: string, bankTxId: string): Promise<SettledDocument[]> {
  const rows = (await sql`
    SELECT * FROM (
      SELECT DISTINCT sd.* FROM bank_transactions bt
      CROSS JOIN LATERAL (${sql.unsafe(settledDocumentsSql('bt'))}) sd
      WHERE bt.id = ${bankTxId}::UUID AND bt.company_id = ${companyId}::UUID
    ) d
    ORDER BY d.entity_type = 'credit_note', d.settles_number, d.entity_number, d.created_at, d.document_id
    LIMIT ${SETTLED_DOCUMENTS_MAX}
  `) as DbRow[];
  return rows.map(mapSettledDocument);
}

/**
 * Is `documentId` a captured document that is the source of a bill / invoice one of the company's bank lines
 * settles? The captured-document-file route serves those bytes to the line's viewer on that ground alone.
 */
export async function isSettledCapturedDocument(companyId: string, documentId: string): Promise<boolean> {
  // From the document outwards (one row), not from every bank line in. Same path and gates as settledDocumentSql,
  // usable-capture predicate included: the gate serves nothing the list would not show.
  const rows = (await sql`
    SELECT 1 FROM captured_documents scd
     WHERE scd.id = ${documentId}::UUID AND scd.company_id = ${companyId}::UUID
       AND NULLIF(scd.storage_path, '') IS NOT NULL AND ${sql.unsafe(capturedDocUsableSql('scd'))}
       AND (EXISTS (SELECT 1 FROM supplier_invoices si
              JOIN payment_allocations a ON a.invoice_id = si.id
              JOIN supplier_payments p ON p.id = a.payment_id AND p.company_id = si.company_id AND p.status <> 'cancelled'
              JOIN gl_journal_lines bl ON bl.journal_entry_id = p.gl_journal_entry_id AND bl.company_id = p.company_id
              JOIN bank_transactions bt ON bt.matched_journal_line_id = bl.id AND bt.company_id = bl.company_id
               AND bl.gl_account_id = bt.bank_account_id AND bt.status = ANY(${[...SETTLING_LINE_STATUSES]}::TEXT[])
             WHERE si.source_document_id = scd.id AND si.company_id = scd.company_id)
         OR EXISTS (SELECT 1 FROM customer_invoices ci
              JOIN customer_payment_allocations a ON a.invoice_id = ci.id
              JOIN customer_payments p ON p.id = a.payment_id AND p.company_id = ci.company_id AND p.status <> 'cancelled'
              JOIN gl_journal_lines bl ON bl.journal_entry_id = p.gl_journal_entry_id AND bl.company_id = p.company_id
              JOIN bank_transactions bt ON bt.matched_journal_line_id = bl.id AND bt.company_id = bl.company_id
               AND bl.gl_account_id = bt.bank_account_id AND bt.status = ANY(${[...SETTLING_LINE_STATUSES]}::TEXT[])
             WHERE ci.source_document_id = scd.id AND ci.company_id = scd.company_id))
  `) as DbRow[];
  return rows.length > 0;
}

/** The wire shape the attachments route and list_documents both send (snake_case, as the bank store's rows). */
export function settledDocumentWire(d: SettledDocument) {
  return {
    source: d.source,
    store: d.store,
    document_id: d.documentId,
    file_name: d.fileName,
    mime_type: d.mimeType,
    file_size: d.fileSize,
    file_url: d.fileUrl,
    created_at: d.createdAt,
    via: { kind: d.via.kind, payment_id: d.via.paymentId, payment_number: d.via.paymentNumber },
    settles: {
      entity_type: d.settles.entityType,
      entity_id: d.settles.entityId,
      number: d.settles.number,
      total: d.settles.total,
      applied: d.settles.applied,
      partial: d.settles.partial,
      invoice_id: d.settles.invoiceId,
      invoice_number: d.settles.invoiceNumber,
    },
  };
}
export type SettledDocumentWire = ReturnType<typeof settledDocumentWire>;

/**
 * A settled document in the attachments list's row shape (components/accounting/bankTxAttachmentHelpers.Attachment),
 * after the line's own rows. Its id is unique per (document, settled entity, payment); it has no delete.
 */
export function settledAttachmentRow(d: SettledDocument, bankTxId: string) {
  return {
    ...settledDocumentWire(d),
    id: `settled:${d.documentId}:${d.settles.entityId}:${d.via.paymentId}`,
    bank_transaction_id: bankTxId,
    file_url: d.fileUrl ?? '',
    uploaded_by: null,
    content_type: d.mimeType,
  };
}
