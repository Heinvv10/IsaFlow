/**
 * reallocate_bank_transaction's document locks, taken in ONE canonical pass BEFORE the old journal head
 * (bank/.claude.md, CANONICAL LOCK ORDER: line -> payments -> invoices ORDER BY id -> journals).
 *
 * A reallocation touches two document sets: the old allocation's (its payment / receipt and the bills or invoices it
 * paid, unwound) and the new target's (the open bills or invoices FIFO is about to consume). Left to the services,
 * the old set is locked by the unwind and the new one by the FIFO fetch AFTER the old journal head and the journal
 * number lock — so two reallocations crossing contacts (A->B beside B->A) each held one contact's bills and waited
 * for the other's, and a reallocation held a journal while waiting on bills a reverse / void / batch held. Here, with
 * only the line locked so far:
 *   1. the contacts whose refund lock the flow will take (`lockContactForRefund`): the old receipts' customers (the
 *      void-credit check) and the new contact on a refund arm — suppliers, then customers, each in id order (a refund
 *      takes line -> contact -> journal -> payment, so contacts precede payments);
 *   2. the old journal's live payments / receipts, `FOR UPDATE`, id order;
 *   3. the bills, then the invoices: the old payments' allocated documents UNION the new contact's open documents
 *      (a superset of what the FIFO fetch reads), ONE `ORDER BY id` pass per table, `FOR UPDATE`.
 * Every later lock on these rows (unwind, FIFO fetch, plan/apply) is then re-entrant. All under the caller's flow
 * lock budget (a wait past it is the retryable ROW_LOCK_TIMEOUT). Residual: a bill or invoice that becomes open
 * after step 3 (approved meanwhile) is still locked by the FIFO fetch after the journal head.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { lockContactForRefund } from '../core/paymentLock';
import { FIFO_ELIGIBLE_STATUSES } from '../ar/invoiceStatusRecompute';
import type { AutoApplyMode } from '../shared/autoAllocateStrategy';
import type { ReallocationTarget } from './bankReallocationGuards';

export interface ReallocationLockInput {
  /** The old allocation journal (the chain root: v1 refuses any other shape). */
  journalId: string;
  target: ReallocationTarget;
  /** Money out on the statement line. */
  spent: boolean;
  autoApply: AutoApplyMode;
}

export interface LockedOldDocuments { supplierPaymentIds: string[]; customerPaymentIds: string[] }

const ids = (rows: DbRow[], col = 'id') => rows.map((r) => String(r[col]));
const sorted = (xs: readonly string[]) => [...new Set(xs.map((x) => x.toLowerCase()))].sort();

/** Steps 1-3 above. Returns the old live payments (for the void-credit check). */
export async function lockReallocationDocuments(companyId: string, input: ReallocationLockInput): Promise<LockedOldDocuments> {
  const { journalId, target, spent, autoApply } = input;
  // Unlocked reads of WHICH rows to lock; the locks below re-read nothing these decide on.
  const oldCustomers = ids((await sql`
    SELECT DISTINCT client_id::TEXT AS c FROM customer_payments
    WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${journalId}::UUID AND status <> 'cancelled'
      AND client_id IS NOT NULL`) as DbRow[], 'c');
  const refundSupplier = target.kind === 'supplier' && !spent ? [target.supplierId] : [];
  const refundCustomer = target.kind === 'customer' && spent ? [target.customerId] : [];
  for (const id of sorted(refundSupplier)) await lockContactForRefund(companyId, 'supplier', id);
  for (const id of sorted([...oldCustomers, ...refundCustomer])) await lockContactForRefund(companyId, 'customer', id);

  const supplierPaymentIds = ids((await sql`
    SELECT id::TEXT AS id FROM supplier_payments
    WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${journalId}::UUID AND status <> 'cancelled'
    ORDER BY id FOR UPDATE`) as DbRow[]);
  const customerPaymentIds = ids((await sql`
    SELECT id::TEXT AS id FROM customer_payments
    WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${journalId}::UUID AND status <> 'cancelled'
    ORDER BY id FOR UPDATE`) as DbRow[]);

  const fifo = autoApply !== 'none';
  const fifoSupplier = fifo && target.kind === 'supplier' && spent ? target.supplierId : null;
  const fifoCustomer = fifo && target.kind === 'customer' && !spent ? target.customerId : null;
  const statuses = [...FIFO_ELIGIBLE_STATUSES];
  await sql`
    SELECT si.id FROM supplier_invoices si
    WHERE si.company_id = ${companyId}::UUID
      AND (si.id IN (SELECT pa.invoice_id FROM payment_allocations pa WHERE pa.payment_id = ANY(${supplierPaymentIds}::UUID[]))
        OR (si.supplier_id = ${fifoSupplier}::UUID AND si.deleted_at IS NULL AND si.status = ANY(${statuses}::TEXT[])
            AND si.total_amount - COALESCE(si.amount_paid, 0) > 0))
    ORDER BY si.id FOR UPDATE OF si`;
  await sql`
    SELECT ci.id FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}::UUID
      AND (ci.id IN (SELECT cpa.invoice_id FROM customer_payment_allocations cpa
                     WHERE cpa.payment_id = ANY(${customerPaymentIds}::UUID[]))
        OR (COALESCE(ci.client_id, ci.customer_id) = ${fifoCustomer}::UUID AND ci.deleted_at IS NULL
            AND ci.status = ANY(${statuses}::TEXT[]) AND ci.total_amount - COALESCE(ci.amount_paid, 0) > 0))
    ORDER BY ci.id FOR UPDATE OF ci`;
  return { supplierPaymentIds, customerPaymentIds };
}
