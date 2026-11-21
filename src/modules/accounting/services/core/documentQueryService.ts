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
 *    entity listing must call verifyEntityOwnershipTyped FIRST and refuse before
 *    reading. That ordering is the fence; do not reorder it.
 *
 * Extracted from pages/api/accounting/documents.ts, which is now a caller.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { entityTableName, hasEntityDocumentSql, type DocumentedEntityType } from './documentPresenceSql';
import type { AccountingEntityType, LinkedDocument } from '@/types/procurement/document.types';
import {
  VALID_ENTITY_TYPES,
  mapRow,
  verifyEntityOwnershipTyped,
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
 * reached through an older document_links row is listed once (the link row's reason wins). Every linked document, however it was
 * reached, is shown only when its own parent (entity_type + entity_id) is a row of `companyId` (gate finding 2).
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
  // BEFORE any read: procurement_documents cannot fence itself. The id must be a row of THE REQUESTED TYPE of this company (Codex round
  // 3, finding 2): "some row with this id is ours" let another company's note sharing an id with one of our bills through.
  if (!(await verifyEntityOwnershipTyped(entityType as AccountingEntityType, entityId, companyId))) {
    return { ok: false, reason: 'entity_not_found' };
  }

  // A goods received note's documents are filed under both its entity type and the legacy goods_receipt_note (review L3); the legacy
  // row is fenced to a note of this company here too.
  const directRows = (await sql`
    SELECT * FROM procurement_documents
    WHERE (entity_type = ${entityType}
           OR (${entityType}::text = 'goods_received' AND entity_type = 'goods_receipt_note'
               AND EXISTS (SELECT 1 FROM goods_received_notes g WHERE g.id = ${entityId}::uuid AND g.company_id = ${companyId}::uuid)))
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
        JOIN (SELECT b.purchase_order_id AS id FROM bill b
              UNION
              SELECT l.purchase_order_id FROM purchase_order_bill_links l, bill
               WHERE l.company_id = ${companyId}::uuid AND l.supplier_invoice_id = ${entityId}::uuid
              UNION
              SELECT pi.purchase_order_id FROM supplier_invoice_items sii JOIN po_items pi ON pi.id = sii.po_item_id, bill
               WHERE sii.supplier_invoice_id = ${entityId}::uuid) named ON named.id = po.id
       WHERE po.company_id = ${companyId}::uuid
    ), bill_note AS (
      SELECT g.id FROM goods_received_notes g WHERE g.company_id = ${companyId}::uuid AND g.id IN (SELECT b.grn_id FROM bill b)
    ), reached AS (
      -- A note is also linked to under the legacy alias goods_receipt_note (round 3, finding 6). On a bill, an older AUTOMATIC row
      -- (po_invoice_link / grn_invoice_link: a PO's or note's paperwork) is shown only while its document's parent is the bill's
      -- current note or one of the POs it names now (round 3, finding 4); a manual row always.
      SELECT dl.document_id, dl.link_reason, 0 AS rank FROM document_links dl
       WHERE (dl.linked_entity_type = ${entityType} OR (${entityType}::text = 'goods_received' AND dl.linked_entity_type = 'goods_receipt_note'))
         AND dl.linked_entity_id = ${entityId}::uuid
         AND (${entityType}::text <> 'supplier_invoice' OR COALESCE(dl.link_reason, '') NOT IN ('po_invoice_link', 'grn_invoice_link')
              OR EXISTS (SELECT 1 FROM procurement_documents d WHERE d.id = dl.document_id
                          AND ((d.entity_type = 'purchase_order' AND d.entity_id IN (SELECT id FROM bill_pos))
                               OR (d.entity_type IN ('goods_received', 'goods_receipt_note') AND d.entity_id IN (SELECT id FROM bill_note)))))
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
      -- The document's own parent must be this company's (gate finding 2): a document_links row carries no company, and row
      -- security admits every company the user belongs to. The table's policy, with the membership replaced by companyId; an
      -- entity type the policy does not name is never shown.
      AND (
        (pd.entity_type = 'supplier_invoice' AND EXISTS (SELECT 1 FROM supplier_invoices p WHERE p.id = pd.entity_id AND p.company_id = ${companyId}::uuid))
        OR (pd.entity_type = 'customer_invoice' AND EXISTS (SELECT 1 FROM customer_invoices p WHERE p.id = pd.entity_id AND p.company_id = ${companyId}::uuid))
        OR (pd.entity_type = 'supplier_payment' AND EXISTS (SELECT 1 FROM supplier_payments p WHERE p.id = pd.entity_id AND p.company_id = ${companyId}::uuid))
        OR (pd.entity_type = 'customer_payment' AND EXISTS (SELECT 1 FROM customer_payments p WHERE p.id = pd.entity_id AND p.company_id = ${companyId}::uuid))
        OR (pd.entity_type = 'credit_note' AND EXISTS (SELECT 1 FROM credit_notes p WHERE p.id = pd.entity_id AND p.company_id = ${companyId}::uuid))
        OR (pd.entity_type = 'purchase_order' AND EXISTS (SELECT 1 FROM purchase_orders p WHERE p.id = pd.entity_id AND p.company_id = ${companyId}::uuid))
        OR (pd.entity_type IN ('goods_received', 'goods_receipt_note')
            AND EXISTS (SELECT 1 FROM goods_received_notes p WHERE p.id = pd.entity_id AND p.company_id = ${companyId}::uuid))
      )
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
