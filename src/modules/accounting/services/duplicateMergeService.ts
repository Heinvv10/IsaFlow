/**
 * Duplicate Merge Service
 * PRD: WS-6.6 — Duplicate Detection and Merge Wizard
 *
 * Merges duplicate entities by reassigning related transactions to the
 * primary record, then soft-deletes the duplicate.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqlResult = { rowCount?: number };

export interface MergeResult {
  reassignedTransactions: number;
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

  if (entityType === 'customer') return mergeCustomers(companyId, primaryId, duplicateId);
  if (entityType === 'supplier') return mergeSuppliers(companyId, primaryId, duplicateId);
  return mergeItems(companyId, primaryId, duplicateId);
}

// ── Customer merge ────────────────────────────────────────────────────────────

async function mergeCustomers(companyId: string, primaryId: string, duplicateId: string): Promise<MergeResult> {
  const check = await sql`
    SELECT id FROM customers
    WHERE id IN (${primaryId}::UUID, ${duplicateId}::UUID)
      AND company_id = ${companyId}::UUID
      AND deleted_at IS NULL
  `;
  if ((check as unknown[]).length !== 2) throw new Error('One or both customers not found for this company');

  let count = 0;

  // customer_invoices has both customer_id and client_id
  const r1 = await sql`
    UPDATE customer_invoices
    SET customer_id = ${primaryId}::UUID, client_id = ${primaryId}::UUID
    WHERE company_id = ${companyId}::UUID
      AND (customer_id = ${duplicateId}::UUID OR client_id = ${duplicateId}::UUID)
  ` as unknown as SqlResult;
  count += Number(r1.rowCount ?? 0);

  const r2 = await sql`
    UPDATE customer_payments SET client_id = ${primaryId}::UUID
    WHERE company_id = ${companyId}::UUID AND client_id = ${duplicateId}::UUID
  ` as unknown as SqlResult;
  count += Number(r2.rowCount ?? 0);

  const r3 = await sql`
    UPDATE credit_notes SET client_id = ${primaryId}::UUID
    WHERE company_id = ${companyId}::UUID AND client_id = ${duplicateId}::UUID
  ` as unknown as SqlResult;
  count += Number(r3.rowCount ?? 0);

  const r4 = await sql`
    UPDATE customer_sales_orders SET customer_id = ${primaryId}::UUID
    WHERE company_id = ${companyId}::UUID AND customer_id = ${duplicateId}::UUID
  ` as unknown as SqlResult;
  count += Number(r4.rowCount ?? 0);

  const r5 = await sql`
    UPDATE customer_quotes SET client_id = ${primaryId}::UUID
    WHERE company_id = ${companyId}::UUID AND client_id = ${duplicateId}::UUID
  ` as unknown as SqlResult;
  count += Number(r5.rowCount ?? 0);

  await sql`
    UPDATE customers SET deleted_at = NOW()
    WHERE id = ${duplicateId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Customer merge complete', { primaryId, duplicateId, count }, 'duplicate-merge');
  return { reassignedTransactions: count };
}

// ── Supplier merge ────────────────────────────────────────────────────────────

async function mergeSuppliers(companyId: string, primaryId: string, duplicateId: string): Promise<MergeResult> {
  const check = await sql`
    SELECT id FROM suppliers
    WHERE id IN (${primaryId}::UUID, ${duplicateId}::UUID)
      AND company_id = ${companyId}::UUID
      AND deleted_at IS NULL
  `;
  if ((check as unknown[]).length !== 2) throw new Error('One or both suppliers not found for this company');

  let count = 0;

  const r1 = await sql`
    UPDATE supplier_invoices SET supplier_id = ${primaryId}::UUID
    WHERE company_id = ${companyId}::UUID AND supplier_id = ${duplicateId}::UUID
  ` as unknown as SqlResult;
  count += Number(r1.rowCount ?? 0);

  const r2 = await sql`
    UPDATE supplier_payments SET supplier_id = ${primaryId}::UUID
    WHERE company_id = ${companyId}::UUID AND supplier_id = ${duplicateId}::UUID
  ` as unknown as SqlResult;
  count += Number(r2.rowCount ?? 0);

  const r3 = await sql`
    UPDATE supplier_purchase_orders SET supplier_id = ${primaryId}::UUID
    WHERE company_id = ${companyId}::UUID AND supplier_id = ${duplicateId}::UUID
  ` as unknown as SqlResult;
  count += Number(r3.rowCount ?? 0);

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
  ` as unknown as SqlResult;
  count += Number(r1.rowCount ?? 0);

  const r2 = await sql`
    UPDATE supplier_purchase_order_items spoi SET item_id = ${primaryId}::UUID
    FROM supplier_purchase_orders spo
    WHERE spoi.purchase_order_id = spo.id
      AND spo.company_id = ${companyId}::UUID
      AND spoi.item_id = ${duplicateId}::UUID
  ` as unknown as SqlResult;
  count += Number(r2.rowCount ?? 0);

  const r3 = await sql`
    UPDATE customer_sales_order_items csoi SET item_id = ${primaryId}::UUID
    FROM customer_sales_orders cso
    WHERE csoi.sales_order_id = cso.id
      AND cso.company_id = ${companyId}::UUID
      AND csoi.item_id = ${duplicateId}::UUID
  ` as unknown as SqlResult;
  count += Number(r3.rowCount ?? 0);

  await sql`
    UPDATE items SET deleted_at = NOW()
    WHERE id = ${duplicateId}::UUID AND company_id = ${companyId}::UUID
  `;

  log.info('Item merge complete', { primaryId, duplicateId, count }, 'duplicate-merge');
  return { reassignedTransactions: count };
}
