/**
 * Reading the document stores. `attach_document` and the documents upload
 * endpoint both WRITE and nothing read them back over the API, so
 * "which transactions over R10,000 have no supporting document" — a standard
 * audit test — has been unanswerable.
 *
 * There are TWO stores and they are not interchangeable:
 *
 *  - `bank_transaction_attachments` — what attach_document writes. No
 *    company_id column; the tenant fence is the parent bank transaction, so
 *    every query here joins bank_transactions and filters on ITS company_id.
 *  - `procurement_documents` (+ `document_links`) — what the documents upload
 *    endpoint writes, keyed by (entity_type, entity_id). Also no company_id,
 *    and no parent table it can be joined to generically — which is why an
 *    entity listing must call verifyEntityOwnership FIRST and refuse before
 *    reading. That ordering is the fence; do not reorder it.
 *
 * Extracted from pages/api/accounting/documents.ts, which is now a caller.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { entityTableName, hasEntityDocumentSql, type DocumentedEntityType } from './documentPresenceSql';
import type { LinkedDocument } from '@/types/procurement/document.types';
import {
  VALID_ENTITY_TYPES,
  mapRow,
  verifyEntityOwnership,
} from './documentStorageService';

export type EntityDocumentsResult =
  | { ok: true; documents: LinkedDocument[]; hasMore: boolean }
  | { ok: false; reason: 'invalid_entity_type' | 'entity_not_found' };

/**
 * Direct + cross-linked documents for one accounting entity.
 *
 * A bill's (supplier_invoice) linked documents also include, resolved HERE at read time, the active documents of its goods received
 * note (`grn_id`; entity types goods_received and the legacy goods_receipt_note, link reason grn_invoice_link) and of its POs (the
 * header `purchase_order_id` and its purchase_order_bill_links rows; po_invoice_link), so a delivery note filed before or after the
 * bill shows on it without a link row being written (merge-gate finding 4). Every id read off the bill is fenced to `companyId`: the
 * bill's PO and note columns carry no foreign key, and row security admits every company the user belongs to. A document also
 * reached through an older document_links row is listed once (the link row's reason wins).
 *
 * The cap is per query and the merged result is at most 2×limit — the two
 * stores are paged independently because they have different orderings and a
 * merged keyset over both would need a shared sort key they do not have.
 */
export async function listEntityDocuments(
  companyId: string,
  entityType: string,
  entityId: string,
  limit: number,
  offset: number,
): Promise<EntityDocumentsResult> {
  if (!(VALID_ENTITY_TYPES as readonly string[]).includes(entityType)) {
    return { ok: false, reason: 'invalid_entity_type' };
  }
  // BEFORE any read: procurement_documents cannot fence itself.
  if (!(await verifyEntityOwnership(entityId, companyId))) {
    return { ok: false, reason: 'entity_not_found' };
  }

  const directRows = (await sql`
    SELECT * FROM procurement_documents
    WHERE entity_type = ${entityType}
      AND entity_id = ${entityId}::uuid
      AND is_active = true
    ORDER BY uploaded_at DESC, id DESC
    LIMIT ${limit + 1} OFFSET ${offset}
  `) as DbRow[];

  const linkedRows = (await sql`
    WITH bill AS (
      SELECT si.purchase_order_id, si.grn_id FROM supplier_invoices si
       WHERE ${entityType}::text = 'supplier_invoice' AND si.id = ${entityId}::uuid AND si.company_id = ${companyId}::uuid
    ), bill_pos AS (
      SELECT po.id FROM purchase_orders po
       WHERE po.company_id = ${companyId}::uuid
         AND (po.id IN (SELECT b.purchase_order_id FROM bill b)
           OR po.id IN (SELECT l.purchase_order_id FROM purchase_order_bill_links l, bill
                         WHERE l.company_id = ${companyId}::uuid AND l.supplier_invoice_id = ${entityId}::uuid))
    ), bill_note AS (
      SELECT g.id FROM goods_received_notes g WHERE g.company_id = ${companyId}::uuid AND g.id IN (SELECT b.grn_id FROM bill b)
    ), reached AS (
      SELECT dl.document_id, dl.link_reason, 0 AS rank FROM document_links dl
       WHERE dl.linked_entity_type = ${entityType} AND dl.linked_entity_id = ${entityId}::uuid
      UNION ALL
      SELECT d.id, 'po_invoice_link', 1 FROM procurement_documents d
       WHERE d.entity_type = 'purchase_order' AND d.entity_id IN (SELECT id FROM bill_pos)
      UNION ALL
      SELECT d.id, 'grn_invoice_link', 1 FROM procurement_documents d
       WHERE d.entity_type IN ('goods_received', 'goods_receipt_note') AND d.entity_id IN (SELECT id FROM bill_note)
    ), once AS (
      SELECT DISTINCT ON (r.document_id) r.document_id, r.link_reason FROM reached r ORDER BY r.document_id, r.rank
    )
    SELECT pd.*, once.link_reason
    FROM once
    JOIN procurement_documents pd ON pd.id = once.document_id
    WHERE pd.is_active = true
    ORDER BY pd.uploaded_at DESC, pd.id DESC
    LIMIT ${limit + 1} OFFSET ${offset}
  `) as DbRow[];

  return {
    ok: true,
    hasMore: directRows.length > limit || linkedRows.length > limit,
    documents: [
      ...directRows.slice(0, limit).map((r) => mapRow(r as Record<string, unknown>, 'direct')),
      ...linkedRows.slice(0, limit).map((r) =>
        mapRow(r as Record<string, unknown>, 'linked', r.link_reason as string)),
    ],
  };
}

/**
 * Which of `ids` carry at least one supporting document (core/documentPresenceSql: the entity store, directly or
 * through document_links, plus a bill's or invoice's source captured document). ONE query for a whole export page.
 * The fence is the entity's own table: an id counts only when it is a row of `entityType`'s table AND belongs to
 * `companyId`, so a foreign or mistyped id never reads procurement_documents.
 */
export async function entityIdsWithDocuments(
  companyId: string,
  entityType: DocumentedEntityType,
  ids: readonly string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = (await sql`
    SELECT e.id FROM ${sql.unsafe(entityTableName(entityType))} e
    WHERE e.company_id = ${companyId}::uuid AND e.id = ANY(${ids as string[]}::uuid[])
      AND ${sql.unsafe(hasEntityDocumentSql(entityType, 'e'))}
  `) as DbRow[];
  return new Set(rows.map((r) => String(r.id)));
}

// Bank-line documents (uploads and linked captured documents) live in ./bankAttachmentQuery.
export { listBankAttachments } from './bankAttachmentQuery';
export type { BankAttachmentRow, AttachmentFilters, AttachmentPage } from './bankAttachmentQuery';

// "Which transactions have no supporting evidence" lives in ./unsupportedTransactionsQuery.
export { listTransactionsWithoutDocuments } from './unsupportedTransactionsQuery';
export type { UnsupportedTxRow, UnsupportedFilters, UnsupportedPage, Evidence } from './unsupportedTransactionsQuery';
