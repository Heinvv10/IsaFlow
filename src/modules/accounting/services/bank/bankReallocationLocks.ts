/**
 * reallocate_bank_transaction's document locks, taken in ONE canonical pass BEFORE the old journal head
 * (bank/.claude.md, CANONICAL LOCK ORDER: line -> payments -> invoices ORDER BY id -> journals).
 *
 * A reallocation touches two document sets: the old allocation's (its payment / receipt and the bills or invoices it
 * paid, unwound) and the new target's (the open bills or invoices FIFO is about to consume). Left to the services,
 * the old set is locked by the unwind and the new one by the FIFO fetch AFTER the old journal head and the journal
 * number lock — so two reallocations crossing contacts (A->B beside B->A) each held one contact's bills and waited
 * for the other's. Here, with only the line locked so far:
 *   1. the old journal's live payments / receipts, `FOR UPDATE`, id order;
 *   2. the bills, then the invoices: the old payments' allocated documents UNION the new contact's open documents
 *      (`openDocumentsOf`, a superset of what the FIFO fetch reads), ONE `ORDER BY id` pass per table, `FOR UPDATE`;
 *   3. the contacts whose refund lock the flow will take (`lockContactForRefund`): the old receipts' customers (the
 *      credit ceiling) and the new contact on a refund arm — suppliers, then customers, each in id order. AFTER the
 *      documents, as the customer merge takes them (payments -> invoices -> customers, ar/customerMergeService), and
 *      before any journal, as a refund takes them (contact -> journal number -> payment).
 * Every later lock on these rows (unwind, FIFO fetch, plan/apply) is then re-entrant. All under the caller's flow
 * lock budget (a wait past it is the retryable ROW_LOCK_TIMEOUT).
 *
 * RECORDED CYCLE (breaker R2-4, retryable): the journal-number lock (migrations 857/858, `<company>:<year>`, taken by
 * the numbering triggers) comes AFTER step 2 here, while allocate / bulk allocate / the rule sweep take it at their
 * journal INSERT and THEN FIFO-lock bills. A multi-line poster that has numbered a journal and then FIFOs a bill this
 * pass holds, while this request waits for the number, is a 40P01: Postgres kills one, it rolls back whole and the
 * MCP answer says retry. Taking the number first would invert the refund path's contact -> number order instead (and
 * the key exists only inside the trigger SQL), so the cycle is recorded, not moved. Residual: a bill or invoice that
 * becomes open after step 2 (approved meanwhile) is still locked by the FIFO fetch after the journal head.
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
const statuses = () => [...FIFO_ELIGIBLE_STATUSES];

/** The ONE definition of "an open document FIFO may settle" for this flow (a superset of the FIFO fetchers'). */
function openBill(supplierId: string | null) {
  return sql`(si.supplier_id = ${supplierId}::UUID AND si.deleted_at IS NULL AND si.status = ANY(${statuses()}::TEXT[])
    AND si.total_amount - COALESCE(si.amount_paid, 0) > 0)`;
}
function openInvoice(customerId: string | null) {
  return sql`(COALESCE(ci.client_id, ci.customer_id) = ${customerId}::UUID AND ci.deleted_at IS NULL
    AND ci.status = ANY(${statuses()}::TEXT[]) AND ci.total_amount - COALESCE(ci.amount_paid, 0) > 0)`;
}

/** The contact FIFO would settle for this target and direction, or null (an account target, a refund, 'none'). */
export function fifoContactOf(target: ReallocationTarget, spent: boolean, autoApply: AutoApplyMode | undefined) {
  if ((autoApply ?? 'fifo') === 'none') return null;
  if (target.kind === 'supplier' && spent) return { kind: 'supplier' as const, id: target.supplierId };
  if (target.kind === 'customer' && !spent) return { kind: 'customer' as const, id: target.customerId };
  return null;
}

/** How many open documents the contact has for FIFO to settle (unlocked read). */
export async function openDocumentsOf(companyId: string, contact: { kind: 'supplier' | 'customer'; id: string }): Promise<number> {
  const [r] = (contact.kind === 'supplier'
    ? await sql`SELECT COUNT(*)::INT AS n FROM supplier_invoices si WHERE si.company_id = ${companyId}::UUID AND ${openBill(contact.id)}`
    : await sql`SELECT COUNT(*)::INT AS n FROM customer_invoices ci WHERE ci.company_id = ${companyId}::UUID AND ${openInvoice(contact.id)}`
  ) as DbRow[];
  return Number(r?.n ?? 0);
}

/** Steps 1-3 above. Returns the old live payments (for the credit ceiling). */
export async function lockReallocationDocuments(companyId: string, input: ReallocationLockInput): Promise<LockedOldDocuments> {
  const { journalId, target, spent, autoApply } = input;
  const supplierPaymentIds = ids((await sql`
    SELECT id::TEXT AS id FROM supplier_payments
    WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${journalId}::UUID AND status <> 'cancelled'
    ORDER BY id FOR UPDATE`) as DbRow[]);
  const customerRows = (await sql`
    SELECT id::TEXT AS id, client_id::TEXT AS c FROM customer_payments
    WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${journalId}::UUID AND status <> 'cancelled'
    ORDER BY id FOR UPDATE`) as DbRow[];
  const customerPaymentIds = ids(customerRows);

  const fifo = fifoContactOf(target, spent, autoApply);
  await sql`
    SELECT si.id FROM supplier_invoices si
    WHERE si.company_id = ${companyId}::UUID
      AND (si.id IN (SELECT pa.invoice_id FROM payment_allocations pa WHERE pa.payment_id = ANY(${supplierPaymentIds}::UUID[]))
        OR ${openBill(fifo?.kind === 'supplier' ? fifo.id : null)})
    ORDER BY si.id FOR UPDATE OF si`;
  await sql`
    SELECT ci.id FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}::UUID
      AND (ci.id IN (SELECT cpa.invoice_id FROM customer_payment_allocations cpa
                     WHERE cpa.payment_id = ANY(${customerPaymentIds}::UUID[]))
        OR ${openInvoice(fifo?.kind === 'customer' ? fifo.id : null)})
    ORDER BY ci.id FOR UPDATE OF ci`;

  const oldCustomers = customerRows.map((r) => r.c).filter((c): c is string => typeof c === 'string');
  const refundSupplier = target.kind === 'supplier' && !spent ? [target.supplierId] : [];
  const refundCustomer = target.kind === 'customer' && spent ? [target.customerId] : [];
  for (const id of sorted(refundSupplier)) await lockContactForRefund(companyId, 'supplier', id);
  for (const id of sorted([...oldCustomers, ...refundCustomer])) await lockContactForRefund(companyId, 'customer', id);
  return { supplierPaymentIds, customerPaymentIds };
}
