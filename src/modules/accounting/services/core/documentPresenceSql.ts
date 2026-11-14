/**
 * "Has a supporting document", as SQL, for every accounting document the app attaches files to: ONE definition for
 * the bill / invoice `hasDocument` flag, the supplier-bill "Missing document" filter, the GL export's Has_Document
 * column and the MCP list_missing_documents tool, so no two surfaces disagree. COMPUTED from the document tables on
 * every read — never from a cached flag.
 *
 * The entity store (procurement_documents, written by POST /api/accounting/documents and attach_entity_document)
 * counts an ACTIVE row filed directly on the entity or cross-linked to it through document_links — EXCEPT a link
 * made for a purchase order or goods receipt. The only document_links writer is autoLinkSupplierInvoice
 * (documentStorageService), which links a bill to its PO's and GRN's documents with link_reason 'po_invoice_link' /
 * 'grn_invoice_link': those are the order's paperwork, not the supplier's tax invoice, so a bill whose own scan is gone
 * is still missing its document (census of every document_links writer, 2026-11-13: no other reason exists).
 * A bill and a customer invoice also count their SOURCE captured document (source_document_id) when it is this
 * company's, still has stored bytes and is not rejected: an invoice created from a capture IS supported
 * by the scan, even though no procurement_documents row exists. A bare `source_document_id IS NOT NULL` is not
 * enough — a capture whose bytes were never stored, or that was rejected, supports nothing, and the flag used to say
 * it did. A NULL status is not a rejection (capturedDocUsableSql says so rather than leaning on NULL <> 'rejected'; 'rejected'
 * is the only captured_documents status that disqualifies — 'failed' / 'discarded' are capture_events statuses). For a CUSTOMER invoice
 * source_document_id is the app's own PDF snapshot of the invoice it issued — that IS the issued document, so it counts.
 *
 * A bank line's definition is bank/bankLineDocumentSql (re-exported below); the VAT journal check is
 * reports/vatInputSupport. The two stores are not linked: a bank line whose receipt was filed against the related
 * bill is still unsupported ON THE LINE, and the reverse.
 *
 * Aliases are fixed code constants, never input, so these are safe for sql.unsafe. Tenant scope: the entity store has
 * no company_id, so the caller's own query must already be scoped to the company on `alias` (every caller selects
 * FROM the entity's own table WHERE company_id = …); the captured-source arm re-checks company_id itself.
 */
import { capturedDocUsableSql, hasBankLineDocumentSql } from '../bank/bankLineDocumentSql';

/** document_links.link_reason values that are a PO's or GRN's paperwork, not the entity's own supporting document. */
export const ORDER_PAPERWORK_LINK_REASONS = ['po_invoice_link', 'grn_invoice_link'] as const;
const sqlList = (values: readonly string[]): string => values.map((v) => `'${v}'`).join(', ');

export type DocumentedEntityType =
  | 'supplier_invoice' | 'customer_invoice' | 'credit_note' | 'supplier_payment' | 'customer_payment';

type Alias = 'si' | 'ci' | 'cn' | 'e' | 'sp' | 'cp';

/** Entity types whose own row names a source captured document. */
const HAS_SOURCE_DOCUMENT: ReadonlySet<DocumentedEntityType> = new Set(['supplier_invoice', 'customer_invoice']);

const ENTITY_TABLE: Record<DocumentedEntityType, string> = {
  supplier_invoice: 'supplier_invoices',
  customer_invoice: 'customer_invoices',
  credit_note: 'credit_notes',
  supplier_payment: 'supplier_payments',
  customer_payment: 'customer_payments',
};

/** The table an entity type's rows live in (a fixed map, never input). */
export function entityTableName(entityType: DocumentedEntityType): string {
  const table = ENTITY_TABLE[entityType];
  if (!table) throw new Error(`unknown document entity type: ${String(entityType)}`);
  return table;
}

/** The entity has an ACTIVE procurement_documents row, filed on it directly or cross-linked to it. */
export function entityStoreDocumentSql(entityType: DocumentedEntityType, alias: Alias): string {
  entityTableName(entityType); // validates the literal interpolated below
  return `(EXISTS (SELECT 1 FROM procurement_documents pd`
    + ` WHERE pd.entity_type = '${entityType}' AND pd.entity_id = ${alias}.id AND pd.is_active = true)`
    + ` OR EXISTS (SELECT 1 FROM document_links dl JOIN procurement_documents pd ON pd.id = dl.document_id`
    + ` WHERE dl.linked_entity_type = '${entityType}' AND dl.linked_entity_id = ${alias}.id AND pd.is_active = true`
    + ` AND COALESCE(dl.link_reason, '') NOT IN (${sqlList(ORDER_PAPERWORK_LINK_REASONS)})))`;
}

/** The entity's source_document_id names this company's captured document, with stored bytes, not rejected. */
export function sourceCapturedDocumentSql(alias: Alias): string {
  return `EXISTS (SELECT 1 FROM captured_documents scd WHERE scd.id = ${alias}.source_document_id`
    + ` AND scd.company_id = ${alias}.company_id AND NULLIF(scd.storage_path, '') IS NOT NULL`
    + ` AND ${capturedDocUsableSql('scd')})`;
}

/** Boolean expression: the accounting document `alias` has at least one supporting document. */
export function hasEntityDocumentSql(entityType: DocumentedEntityType, alias: Alias): string {
  const store = entityStoreDocumentSql(entityType, alias);
  return HAS_SOURCE_DOCUMENT.has(entityType) ? `(${store} OR ${sourceCapturedDocumentSql(alias)})` : store;
}

/** Boolean expression: the accounting document `alias` has NO supporting document. */
export function lacksEntityDocumentSql(entityType: DocumentedEntityType, alias: Alias): string {
  return `NOT ${hasEntityDocumentSql(entityType, alias)}`;
}

export { hasBankLineDocumentSql };
