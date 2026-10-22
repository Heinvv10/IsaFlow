/**
 * Duplicate Merge Service
 * PRD: WS-6.6 — Duplicate Detection and Merge Wizard
 *
 * Merges duplicate entities by reassigning related transactions to the
 * primary record, then soft-deletes the duplicate.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { mergeCustomers } from '../ar/customerMergeService';
import { lockBatchesBeforeSuppliers, lockBatchesPayingSupplier, stampBatchesOfMovedPayments } from '../ap/supplierPaymentAuthors';

export interface MergeResult {
  reassignedTransactions: number;
  /** Customer merges only: recurring invoices/templates moved paused (K-061). */
  pausedRecurring?: number;
  /** Customer merges only: the duplicate's portal logins switched off. */
  revokedPortalLogins?: number;
}

/** A merge refused before anything moved; its message is safe to show. */
export class SupplierMergeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SupplierMergeRefusal';
  }
}

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
  const rows = await lockBatchesBeforeSuppliers(companyId, [movedFromId], null, async () => (await sql`
    SELECT name, COALESCE(subject_to_drc_vat, false) AS drc FROM suppliers
    WHERE id IN (${a}::UUID, ${b}::UUID) AND company_id = ${companyId}::UUID AND deleted_at IS NULL
    ORDER BY id
    FOR UPDATE
  `) as { name: string; drc: boolean }[]);
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

// ── Public API ────────────────────────────────────────────────────────────────

export async function mergeEntities(
  companyId: string,
  entityType: 'customer' | 'supplier' | 'item',
  primaryId: string,
  duplicateId: string,
  userId: string,
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
  if (entityType === 'supplier') return mergeSuppliers(companyId, primaryId, duplicateId, userId);
  return mergeItems(companyId, primaryId, duplicateId);
}

// ── Supplier merge ────────────────────────────────────────────────────────────

async function mergeSuppliers(companyId: string, primaryId: string, duplicateId: string, userId: string): Promise<MergeResult> {
  // Also the existence check: both live suppliers of this company.
  await assertSupplierMergeKeepsDrcFlag(companyId, primaryId, duplicateId, duplicateId);

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
    RETURNING id
  `;
  count += r2.length;

  const r3 = await sql`
    UPDATE supplier_purchase_orders SET supplier_id = ${primaryId}::UUID
    WHERE company_id = ${companyId}::UUID AND supplier_id = ${duplicateId}::UUID
    RETURNING id
  `;
  count += r3.length;

  await sql`
    UPDATE suppliers SET deleted_at = NOW()
    WHERE id = ${duplicateId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Supplier merge complete', { primaryId, duplicateId, count }, 'duplicate-merge');
  return { reassignedTransactions: count };
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

  const r2 = await sql`
    UPDATE supplier_purchase_order_items spoi SET item_id = ${primaryId}::UUID
    FROM supplier_purchase_orders spo
    WHERE spoi.purchase_order_id = spo.id
      AND spo.company_id = ${companyId}::UUID
      AND spoi.item_id = ${duplicateId}::UUID
    RETURNING spoi.id
  `;
  count += r2.length;

  const r3 = await sql`
    UPDATE customer_sales_order_items csoi SET item_id = ${primaryId}::UUID
    FROM customer_sales_orders cso
    WHERE csoi.sales_order_id = cso.id
      AND cso.company_id = ${companyId}::UUID
      AND csoi.item_id = ${duplicateId}::UUID
    RETURNING csoi.id
  `;
  count += r3.length;

  await sql`
    UPDATE items SET deleted_at = NOW()
    WHERE id = ${duplicateId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Item merge complete', { primaryId, duplicateId, count }, 'duplicate-merge');
  return { reassignedTransactions: count };
}
