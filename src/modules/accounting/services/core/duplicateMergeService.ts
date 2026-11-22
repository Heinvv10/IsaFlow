/**
 * Duplicate Merge Service
 * PRD: WS-6.6 — Duplicate Detection and Merge Wizard
 *
 * Merges duplicate entities by reassigning related transactions to the
 * primary record, then soft-deletes the duplicate.
 */

import { sql, withSavepoint } from '@/lib/neon';
import { SupplierMergeRefusal } from './supplierMergeRefusal';
import { assertSupplierMergeMovesNoNotedBill, refuseIfMovedNotedBills } from './supplierMergeNotedBills';
import { log } from '@/lib/logger';
import { mergeCustomers } from '../ar/customerMergeService';
import { lockBatchesPayingSupplier, stampBatchesOfMovedPayments } from '../ap/supplierPaymentAuthors';
import { lockBatchesBeforeSuppliers } from '../ap/batchBeforeSupplierLock';
import { RowLockTimeoutError, withRowLockBudget } from './rowLockBudget';
import { lockMovablePurchaseOrders, movePurchaseOrders } from './supplierMergePurchaseOrders';
import { moveExpectationsAndAlerts, moveIntercompanySide, sideRefusal } from './supplierMergeOpenWork';

export interface MergeResult {
  reassignedTransactions: number;
  /** Customer merges only: recurring invoices/templates moved paused (K-061). */
  pausedRecurring?: number;
  /** Customer merges only: the duplicate's portal logins switched off. */
  revokedPortalLogins?: number;
}

// A merge refused before anything moved (or rolled back whole); its message is safe to show.
export { SupplierMergeRefusal } from './supplierMergeRefusal';
// A source bill carrying a goods received note (#1708): checked before the move, and on the bill UPDATE's RETURNING rows.
export { assertSupplierMergeMovesNoNotedBill, refuseIfMovedNotedBills } from './supplierMergeNotedBills';

/**
 * DRC VAT eligibility reads the supplier's `subject_to_drc_vat` flag, and a
 * merge re-parents every bill. Across differing flags it would make an
 * unflagged supplier's zero-VAT bills (zero-rated, exempt, foreign) DRC
 * candidates, or silently drop eligible ones — so both merge paths refuse
 * until the flags agree. Reads live suppliers of THIS company only.
 *
 * ALSO THE EXISTENCE AND TENANT CHECK for both merge paths — removing the DRC
 * comparison must not remove this function. It takes FOR UPDATE on both rows,
 * held to the end of the request transaction, so a flag change (updateSupplier
 * locks the same row) cannot land between this check and the re-parenting.
 */
export async function assertSupplierMergeKeepsDrcFlag(
  companyId: string, a: string, b: string, movedFromId: string,
): Promise<void> {
  // Batch before supplier (bank/.claude.md): the batches carrying the payments the merge re-points are locked before
  // either supplier row, the order the bank-file gate takes them in. `movedFromId` is the supplier being merged away.
  // Both supplier rows FOR UPDATE, bounded (5 s, a typed retryable RowLockTimeoutError). This is also what serialises a merge against
  // a bill create or a draft supplier change for the source: their write takes KEY SHARE on the supplier through
  // supplier_invoices_supplier_id_fkey, so a bill is either committed before this lock (and seen by the link / note checks after it)
  // or written after the merge commits (and not moved). Lock census: docs/design/mcp-po-bill-links.md.
  const rows = await lockBatchesBeforeSuppliers(companyId, [movedFromId], null, async () => withRowLockBudget(async () => (await sql`
    SELECT name, COALESCE(subject_to_drc_vat, false) AS drc FROM suppliers
    WHERE id IN (${a}::UUID, ${b}::UUID) AND company_id = ${companyId}::UUID AND deleted_at IS NULL
    ORDER BY id
    FOR UPDATE
  `) as { name: string; drc: boolean }[], () => new RowLockTimeoutError('A supplier being merged')));
  if (rows.length !== 2) {
    throw new SupplierMergeRefusal('One or both suppliers not found or do not belong to this company');
  }
  if (rows[0]!.drc !== rows[1]!.drc) {
    const on = rows.find((r) => r.drc)!.name;
    const off = rows.find((r) => !r.drc)!.name;
    throw new SupplierMergeRefusal(
      `${on} is marked "Subject to DRC VAT" and ${off} is not. Merging would change which bills are `
      + 'eligible for DRC VAT. Set the flag the same on both suppliers first, then merge.',
    );
  }
}

/** Shown when a supplier merge is refused because the source has purchase-order <-> bill links (mig 1006). */
export { PO_BILL_LINKS_REFUSAL } from './supplierMergePurchaseOrders';

// ── Public API ────────────────────────────────────────────────────────────────

export async function mergeEntities(
  companyId: string,
  entityType: 'customer' | 'supplier' | 'item',
  primaryId: string,
  duplicateId: string,
  userId: string,
  /** The caller's company role: a supplier merge moves approved purchase orders only for one that may edit them (owner, admin). */
  companyRole?: string | null,
): Promise<MergeResult> {
  log.info('Merging entities', { companyId, entityType, primaryId, duplicateId, userId }, 'duplicate-merge');

  if (primaryId === duplicateId) throw new Error('Primary and duplicate cannot be the same entity');

  // One customer merge for both routes (K-061): this path used to move five
  // tables and leave the duplicate's recurring invoices billing a deleted customer.
  if (entityType === 'customer') {
    const merged = await mergeCustomers(companyId, duplicateId, primaryId, userId);
    return {
      reassignedTransactions: merged.movedDocuments,
      pausedRecurring: merged.pausedRecurring,
      revokedPortalLogins: merged.revokedPortalLogins,
    };
  }
  if (entityType === 'supplier') return mergeSuppliers(companyId, primaryId, duplicateId, userId, companyRole);
  return mergeItems(companyId, primaryId, duplicateId);
}

// ── Supplier merge ────────────────────────────────────────────────────────────

async function mergeSuppliers(
  companyId: string, primaryId: string, duplicateId: string, userId: string, companyRole: string | null | undefined,
): Promise<MergeResult> {
  // Also the existence check: both live suppliers of this company.
  await assertSupplierMergeKeepsDrcFlag(companyId, primaryId, duplicateId, duplicateId);
  await assertSupplierMergeMovesNoNotedBill(companyId, duplicateId);

  // The POs locked, then the link and approved-PO refusals (lockMovablePurchaseOrders), and the intercompany side's.
  const pos = await lockMovablePurchaseOrders(companyId, duplicateId, companyRole);
  const sideBlock = await sideRefusal(companyId, duplicateId, primaryId);
  if (sideBlock) throw new SupplierMergeRefusal(sideBlock);

  // One savepoint for the moves: the side's guard and the bill UPDATE's RETURNING (refuseIfMovedNotedBills) can still refuse, and a
  // 4xx answer is committed by withAuth, so the refusal must take back what was moved before it.
  return withSavepoint('merge_suppliers_moves', async () => {
  const side = await moveIntercompanySide(companyId, duplicateId, primaryId);
  if (side.refusal) throw new SupplierMergeRefusal(side.refusal);
  let count = 0;

  // (2) PAYMENTS BEFORE (3) INVOICES, for the reason given in `mergeCustomers`
  // above — the AP twin of the same inversion.
  // supplier_id is approval content, and with it the payee's bank details
  // (R-035 PR5): the merging user becomes an author of every moved payment and
  // its batch — the batches locked first, batch before members (bank/.claude.md).
  const batchIds = await lockBatchesPayingSupplier(companyId, duplicateId, null);
  const r1 = await sql`
    UPDATE supplier_payments SET supplier_id = ${primaryId}::UUID,
      content_authors = approval_add_author(content_authors, ${userId}::UUID), content_edited_at = NOW()
    WHERE company_id = ${companyId}::UUID AND supplier_id = ${duplicateId}::UUID
    RETURNING id
  `;
  count += r1.length;
  await stampBatchesOfMovedPayments(companyId, batchIds, userId);

  // supplier_id is approval content (R-035): the merging user becomes an author of every moved bill.
  const r2 = await sql`
    UPDATE supplier_invoices SET supplier_id = ${primaryId}::UUID,
      content_authors = approval_add_author(content_authors, ${userId}::UUID), content_edited_at = NOW()
    WHERE company_id = ${companyId}::UUID AND supplier_id = ${duplicateId}::UUID
    RETURNING id, invoice_number, grn_id, deleted_at, status
  `;
  // A bill made live and noted while this ran, without the supplier lock, is moved by this UPDATE after it waited on the row.
  refuseIfMovedNotedBills(r2 as Array<Record<string, unknown>>);
  count += r2.length;

  // supplier_purchase_orders is retired (migration 1022, PR #1703): every row was copied into purchase_orders under the same id,
  // and the legacy table refuses UPDATE (a row trigger), so the canonical move below is the only PO move.
  // purchase_orders is the canonical PO table (mig 246b): moved under the
  // supplier-change controls of updatePurchaseOrder (supplierMergePurchaseOrders). Supplier credit notes live in credit_notes
  // (mig 202); supplier_id is approval content on one, as on a bill. The supplier_id tables that stay on the merged-away row
  // on purpose are listed in supplierMergeOpenWork.
  count += await movePurchaseOrders(companyId, pos, duplicateId, primaryId, { userId, role: companyRole, via: 'supplier-merge' });

  const r5 = await sql`
    UPDATE credit_notes SET supplier_id = ${primaryId}::UUID,
      content_authors = approval_add_author(content_authors, ${userId}::UUID), content_edited_at = NOW()
    WHERE company_id = ${companyId}::UUID AND supplier_id = ${duplicateId}::UUID
    RETURNING id
  `;
  count += r5.length;

  // Not moved transactions, so not counted: the side and the expectation / alert / opt-out work.
  await moveExpectationsAndAlerts(companyId, duplicateId, primaryId, { userId, via: 'supplier-merge' });

  // merged_into_id (migration 1020): the Sage import follows a merged-away supplier to its survivor, so a
  // re-sync does not re-create it as a live supplier and split its new bills from the survivor (#1655).
  await sql`
    UPDATE suppliers SET deleted_at = NOW(), merged_into_id = ${primaryId}::UUID
    WHERE id = ${duplicateId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Supplier merge complete', { primaryId, duplicateId, count }, 'duplicate-merge');
  return { reassignedTransactions: count };
  });
}

// ── Item merge ────────────────────────────────────────────────────────────────

async function mergeItems(companyId: string, primaryId: string, duplicateId: string): Promise<MergeResult> {
  const check = await sql`
    SELECT id FROM items
    WHERE id IN (${primaryId}::UUID, ${duplicateId}::UUID)
      AND company_id = ${companyId}::UUID
      AND deleted_at IS NULL
  `;
  if ((check as unknown[]).length !== 2) throw new Error('One or both items not found for this company');

  let count = 0;

  const r1 = await sql`
    UPDATE customer_invoice_items cii SET item_id = ${primaryId}::UUID
    FROM customer_invoices ci
    WHERE cii.invoice_id = ci.id
      AND ci.company_id = ${companyId}::UUID
      AND cii.item_id = ${duplicateId}::UUID
    RETURNING cii.id
  `;
  count += r1.length;

  const r3 = await sql`
    UPDATE customer_sales_order_items csoi SET item_id = ${primaryId}::UUID
    FROM customer_sales_orders cso
    WHERE csoi.sales_order_id = cso.id
      AND cso.company_id = ${companyId}::UUID
      AND csoi.item_id = ${duplicateId}::UUID
    RETURNING csoi.id
  `;
  count += r3.length;

  // Migration 1005: the other lines that may name an item, and its stock movements. Each is scoped through its document's company.
  const r4 = await sql`
    UPDATE po_items pi SET item_id = ${primaryId}::UUID
    FROM purchase_orders po
    WHERE pi.purchase_order_id = po.id AND po.company_id = ${companyId}::UUID AND pi.item_id = ${duplicateId}::UUID
    RETURNING pi.id
  `;
  const r5 = await sql`
    UPDATE supplier_invoice_items sii SET item_id = ${primaryId}::UUID
    FROM supplier_invoices si
    WHERE sii.supplier_invoice_id = si.id AND si.company_id = ${companyId}::UUID AND sii.item_id = ${duplicateId}::UUID
    RETURNING sii.id
  `;
  const r6 = await sql`
    UPDATE customer_quote_lines cql SET item_id = ${primaryId}::UUID
    FROM customer_quotes cq
    WHERE cql.quote_id = cq.id AND cq.company_id = ${companyId}::UUID AND cql.item_id = ${duplicateId}::UUID
    RETURNING cql.id
  `;
  // Also a legacy row with NO company (a product of no company: only a superuser could write one) that names this company's
  // duplicate: left behind, it would keep the duplicate from ever being purged.
  const r7 = await sql`
    UPDATE stock_movements SET item_id = ${primaryId}::UUID
    WHERE item_id = ${duplicateId}::UUID
      AND (company_id = ${companyId}::UUID
           OR (company_id IS NULL AND NOT EXISTS (SELECT 1 FROM products p WHERE p.id = stock_movements.product_id AND p.company_id <> ${companyId}::UUID)))
    RETURNING id
  `;
  count += r4.length + r5.length + r6.length + r7.length;

  // The duplicate's external identity (migration 1005): left on the soft-deleted row it would refuse every re-sync of that
  // reference (item_deleted / external_ref_in_use) for good. Free it first (the unique index counts deleted rows), then give it to
  // the primary when the primary has none; otherwise it is only cleared, and the duplicate's notes keep what it was.
  const [dup] = (await sql`
    SELECT code, external_system, external_ref, external_document_number FROM items
    WHERE id = ${duplicateId}::UUID AND company_id = ${companyId}::UUID
  `) as Array<{ code: string; external_system: string | null; external_ref: string | null; external_document_number: string | null }>;
  let movedRef = false;
  if (dup?.external_ref) {
    await sql`
      UPDATE items SET external_system = NULL, external_ref = NULL, external_document_number = NULL
      WHERE id = ${duplicateId}::UUID AND company_id = ${companyId}::UUID
    `;
    const given = (await sql`
      UPDATE items SET external_system = ${dup.external_system}::TEXT, external_ref = ${dup.external_ref}::TEXT,
             external_document_number = COALESCE(external_document_number, ${dup.external_document_number}::TEXT), updated_at = NOW()
      WHERE id = ${primaryId}::UUID AND company_id = ${companyId}::UUID AND external_ref IS NULL
      RETURNING id
    `) as unknown[];
    movedRef = given.length > 0;
  }

  await sql`
    UPDATE items SET deleted_at = NOW(),
           notes = concat_ws(E'\n', NULLIF(notes, ''), ${`Merged into another item. ${dup?.external_ref ? `Its external reference ${dup.external_system}/${dup.external_ref} ${movedRef ? 'moved to the primary item' : 'was cleared (the primary item has its own)'}.` : ''}`.trim()}::TEXT)
    WHERE id = ${duplicateId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Item merge complete', { primaryId, duplicateId, count }, 'duplicate-merge');
  return { reassignedTransactions: count };
}
