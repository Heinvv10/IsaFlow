/**
 * Customer merge (K-061): move everything that belongs to `sourceId` onto
 * `targetId`, then soft-delete the source. One transaction; every refusal is
 * raised before the first write, because withAuth COMMITs on a 4xx.
 *
 * The tables moved are the census in docs/audits/remediation/K-061/fix.md.
 * A new table that stores a customer id must be added here AND to
 * `MOVED` in tests/integration/k061-customer-merge.helpers.ts, or a merge
 * strands its rows on the merged-away customer.
 *
 * Product rules (Hein, 2026-09-26):
 *   - both customers with a dunning override → refused, nothing written;
 *   - the source's portal logins are deactivated, never moved;
 *   - the source's active recurring templates move PAUSED, and are counted;
 *   - the source keeps its name + ' [MERGED]' and its Sage history. A Sage
 *     re-sync matches customers by name and so re-creates the old name as a
 *     new, empty customer; the moved Sage invoices are not booked twice.
 */
import { withTransaction, type TxSql } from '@/lib/neon';

/** A merge the caller asked for that must not happen. Raised before any write. */
export class CustomerMergeRefusal extends Error {}

export interface CustomerMergeResult {
  merged: true;
  target_id: string;
  pausedRecurring: number;
  revokedPortalLogins: number;
}

async function refuseOrLock(tx: TxSql, companyId: string, sourceId: string, targetId: string): Promise<void> {
  // Locked in id order so two merges of the same pair, in either direction,
  // queue instead of deadlocking. A merge that waited re-reads deleted_at
  // after the first commits, finds its customer gone, and is refused.
  const live = await tx`
    SELECT id FROM customers
    WHERE id IN (${sourceId}::UUID, ${targetId}::UUID)
      AND company_id = ${companyId}::UUID
      AND deleted_at IS NULL
    ORDER BY id
    FOR UPDATE
  `;
  if (live.length !== 2) {
    throw new CustomerMergeRefusal('One or both customers not found or do not belong to this company');
  }
  const dunning = await tx`
    SELECT count(*)::int AS n FROM customer_dunning_overrides
    WHERE company_id = ${companyId}::UUID AND customer_id IN (${sourceId}::UUID, ${targetId}::UUID)
  ` as Array<{ n: number }>;
  if (dunning[0]!.n === 2) {
    throw new CustomerMergeRefusal('Both customers have dunning settings — remove one first, then merge');
  }
}

/** Documents: every customer column moves independently; a NULL stays NULL. */
async function moveDocuments(tx: TxSql, c: string, s: string, t: string): Promise<void> {
  await tx`UPDATE customer_invoices SET customer_id = ${t}::UUID WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE customer_invoices SET client_id = ${t}::UUID WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE archive_customer_invoices SET customer_id = ${t}::UUID WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE archive_customer_invoices SET client_id = ${t}::UUID WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE customer_payments SET client_id = ${t}::UUID WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE credit_notes SET client_id = ${t}::UUID WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE customer_write_offs SET client_id = ${t}::UUID WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE customer_quotes SET client_id = ${t}::UUID WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE customer_sales_orders SET customer_id = ${t}::UUID WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE delivery_notes SET customer_id = ${t}::UUID WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE projects SET client_id = ${t}::UUID WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE time_entries SET customer_id = ${t}::UUID WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE payment_transactions SET customer_id = ${t}::UUID WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`
    UPDATE accounting_adjustments SET entity_id = ${t}::UUID
    WHERE entity_type = 'customer' AND entity_id = ${s}::UUID AND company_id = ${c}::UUID
  `;
  // Payment links have no company_id; the invoice they belong to does.
  await tx`
    UPDATE portal_payment_links SET client_id = ${t}::UUID
    WHERE client_id = ${s}::UUID
      AND invoice_id IN (SELECT id FROM customer_invoices WHERE company_id = ${c}::UUID)
  `;
}

/** Customer records: the target's primary contact, default address and custom fields win. */
async function moveRecords(tx: TxSql, c: string, s: string, t: string): Promise<void> {
  await tx`
    UPDATE customer_contacts
    SET customer_id = ${t}::UUID,
        is_primary = is_primary AND NOT EXISTS (
          SELECT 1 FROM customer_contacts p
          WHERE p.customer_id = ${t}::UUID AND p.company_id = ${c}::UUID AND p.is_primary)
    WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID
  `;
  await tx`
    UPDATE customer_delivery_addresses
    SET customer_id = ${t}::UUID,
        is_default = is_default AND NOT EXISTS (
          SELECT 1 FROM customer_delivery_addresses d
          WHERE d.customer_id = ${t}::UUID AND d.company_id = ${c}::UUID AND d.is_default)
    WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID
  `;
  await tx`UPDATE customer_activities SET customer_id = ${t}::UUID WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID`;
  // refuseOrLock already refused the case where both have one.
  await tx`UPDATE customer_dunning_overrides SET customer_id = ${t}::UUID WHERE customer_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE bank_categorisation_rules SET client_id = ${t}::UUID WHERE client_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE bank_transactions SET suggested_client_id = ${t}::UUID WHERE suggested_client_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`UPDATE practice_clients SET link_customer_id = ${t}::UUID WHERE link_customer_id = ${s}::UUID AND company_id = ${c}::UUID`;
  await tx`
    DELETE FROM entity_udf_values v
    WHERE v.entity_type = 'customer' AND v.entity_id = ${s}::UUID AND v.company_id = ${c}::UUID
      AND EXISTS (
        SELECT 1 FROM entity_udf_values w
        WHERE w.entity_type = 'customer' AND w.entity_id = ${t}::UUID
          AND w.company_id = ${c}::UUID AND w.field_number = v.field_number)
  `;
  await tx`
    UPDATE entity_udf_values SET entity_id = ${t}::UUID
    WHERE entity_type = 'customer' AND entity_id = ${s}::UUID AND company_id = ${c}::UUID
  `;
}

export async function mergeCustomers(
  companyId: string,
  sourceId: string,
  targetId: string,
): Promise<CustomerMergeResult> {
  if (sourceId === targetId) {
    throw new CustomerMergeRefusal('source_id and target_id must be different customers');
  }
  return withTransaction(async (tx) => {
    await refuseOrLock(tx, companyId, sourceId, targetId);
    await moveDocuments(tx, companyId, sourceId, targetId);
    await moveRecords(tx, companyId, sourceId, targetId);

    const paused = await tx`
      UPDATE recurring_invoices SET status = 'paused'
      WHERE client_id = ${sourceId}::UUID AND company_id = ${companyId}::UUID AND status = 'active'
      RETURNING id
    `;
    await tx`
      UPDATE recurring_invoices SET client_id = ${targetId}::UUID
      WHERE client_id = ${sourceId}::UUID AND company_id = ${companyId}::UUID
    `;
    // portal_access has no company_id and no RLS: scope it through the
    // customer, which refuseOrLock proved is this company's.
    const revoked = await tx`
      UPDATE portal_access SET is_active = false, updated_at = NOW()
      WHERE client_id = ${sourceId}::UUID AND is_active
        AND EXISTS (SELECT 1 FROM customers WHERE id = ${sourceId}::UUID AND company_id = ${companyId}::UUID)
      RETURNING id
    `;
    await tx`
      UPDATE customers
      SET is_active = false, deleted_at = NOW(), name = name || ' [MERGED]'
      WHERE id = ${sourceId}::UUID AND company_id = ${companyId}::UUID
    `;
    return { merged: true, target_id: targetId, pausedRecurring: paused.length, revokedPortalLogins: revoked.length };
  });
}
