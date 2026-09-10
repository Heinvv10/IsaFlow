/**
 * K-053: what a soft-delete of an invoice or a bill is allowed to touch.
 *
 * Split out of softDeleteJournalService to keep both files under the 300-line
 * cap; the GL work lives there, the row lock and the refusals live here.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { SoftDeleteRefusalError } from './softDeleteErrors';

/** Amounts below this (in currency units) are treated as zero, as in cancel. */
export const ZERO_TOLERANCE = 0.005;

/**
 * Lock the invoice for this request transaction and read what the delete
 * decides on. FOR UPDATE for the same reason cancel takes it: two concurrent
 * deletes must not both pass the guards and double-reverse the journal.
 */
export async function lockInvoice(
  entityType: string,
  entityId: string,
  companyId: string,
): Promise<DbRow | null> {
  const rows = (entityType === 'customer_invoice'
    ? await sql`
        SELECT status, amount_paid, gl_journal_entry_id, deleted_at
        FROM customer_invoices
        WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID
        FOR UPDATE
      `
    : await sql`
        SELECT status, amount_paid, gl_journal_entry_id, deleted_at
        FROM supplier_invoices
        WHERE id = ${entityId}::UUID AND company_id = ${companyId}::UUID
        FOR UPDATE
      `) as DbRow[];
  return rows.length > 0 ? rows[0]! : null;
}

/**
 * Settlement allocated to this document by a payment that is not cancelled.
 * `amount_paid` alone is not enough — cancelCustomerInvoiceInner refuses on
 * this second condition too, "to catch pending/draft payments that have not yet
 * incremented amount_paid". Checking only amount_paid left round-1's negative
 * supplier statement reachable, and AP carries 397 production bills with
 * payment_matched = true and amount_paid = 0.
 */
export async function allocatedByLivePayments(
  entityType: string,
  entityId: string,
  companyId: string,
): Promise<number> {
  const rows = (entityType === 'customer_invoice'
    ? await sql`
        SELECT COALESCE(SUM(cpa.amount_allocated), 0) AS allocated
        FROM customer_payment_allocations cpa
        JOIN customer_payments cp ON cp.id = cpa.payment_id
        WHERE cpa.invoice_id = ${entityId}::UUID
          AND cp.company_id = ${companyId}::UUID
          AND cp.status <> 'cancelled'
      `
    : await sql`
        SELECT COALESCE(SUM(spa.amount_allocated), 0) AS allocated
        FROM supplier_payment_allocations spa
        JOIN supplier_payments sp ON sp.id = spa.payment_id
        WHERE spa.invoice_id = ${entityId}::UUID
          AND sp.company_id = ${companyId}::UUID
          AND sp.status <> 'cancelled'
      `) as DbRow[];
  return Number(rows[0]?.allocated ?? 0);
}

/**
 * Every refusal the delete makes on the document row itself, in the order
 * cancel makes them. Returns the locked row so the caller does not read twice.
 */
export async function assertInvoiceDeletable(
  entityType: string,
  entityId: string,
  companyId: string,
): Promise<DbRow> {
  const row = await lockInvoice(entityType, entityId, companyId);
  if (!row || row.deleted_at != null) {
    throw new SoftDeleteRefusalError(`${entityType} not found or already deleted`);
  }
  if (String(row.status) === 'posted') {
    throw new SoftDeleteRefusalError(`Cannot delete a posted ${entityType}`);
  }
  if (Number(row.amount_paid ?? 0) > ZERO_TOLERANCE) {
    throw new SoftDeleteRefusalError(`Cannot delete a ${entityType} with payments`);
  }
  if ((await allocatedByLivePayments(entityType, entityId, companyId)) > ZERO_TOLERANCE) {
    throw new SoftDeleteRefusalError(`Cannot delete a ${entityType} with payments`);
  }
  return row;
}
