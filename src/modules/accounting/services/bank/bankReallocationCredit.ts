/**
 * reallocate_bank_transaction's credit ceiling, both sides, judged by DATE: cancelling the old payment / receipt
 * takes its unapplied remainder off the contact's on-account credit at its own date and every later one, so the
 * LOWEST running credit from that date onward must cover it — a refund recorded later was judged against the credit
 * as at its own date (`planSupplierRefund` / `planCustomerRefund`), and an all-dates figure lets a later-dated
 * document hide a refund left with nothing behind it (breaker R2-2).
 *
 * Supplier side: reallocation only. The AP unwind still runs `ap/supplierVoidCredit.assertVoidKeepsCredit` (all
 * dates, Hein's 2026-10-26 ruling) for every void; this is a stricter check in front of it for this path, and
 * void_payment is unchanged. Supplier: under the supplier's credit key (`ap/supplierCreditLock`, TRIED — no edge in any
 * wait-for cycle), as the void takes it. Customer: `ar/customerVoidCredit` (under the customer's refund lock, tried),
 * the same figure every receipt cancellation asks since 2026-11-14 — here it only words the refusal for reallocation.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { formatMoney } from '@/lib/money/formatMoney';
import { lockSupplierCredit } from '../ap/supplierCreditLock';
import { getSupplierOnAccountCredit } from '../ap/supplierOnAccountCredit';
import { customerVoidCreditShortfall, type CreditReAdd } from '../ar/customerVoidCredit';
import { FIFO_ELIGIBLE_STATUSES } from '../ar/invoiceStatusRecompute';
import type { AutoApplyMode } from '../shared/autoAllocateStrategy';
import { BankReallocationRefusal, type ReallocationTarget } from './bankReallocationGuards';

const cents = (n: number) => Math.round(n * 100);

interface Shortfall { side: 'supplier' | 'customer'; name: string; lowers: number; credit: number; fromDate: string }

/** The first supplier whose lowest running credit from the payments' date cannot cover the cancellation, or null. */
async function supplierShortfall(companyId: string, paymentIds: readonly string[]): Promise<Shortfall | null> {
  if (paymentIds.length === 0) return null;
  const rows = (await sql`
    SELECT sp.supplier_id::TEXT AS supplier_id, MIN(sp.payment_date) AS from_date,
           SUM(sp.total_amount - LEAST(COALESCE(alloc.allocated, 0), GREATEST(sp.total_amount, 0))) AS lowers
    FROM supplier_payments sp
    LEFT JOIN LATERAL (
      SELECT SUM(pa.amount_allocated) AS allocated FROM payment_allocations pa WHERE pa.payment_id = sp.id
    ) alloc ON TRUE
    WHERE sp.company_id = ${companyId}::UUID AND sp.id = ANY(${[...paymentIds]}::UUID[])
      AND sp.status IN ('processed', 'reconciled')
    GROUP BY sp.supplier_id
    ORDER BY sp.supplier_id`) as DbRow[];
  for (const r of rows) {
    const lowers = Number(r.lowers ?? 0);
    if (cents(lowers) <= 0) continue;
    const supplierId = String(r.supplier_id);
    const fromDate = fmtDate(r.from_date as string | Date);
    await lockSupplierCredit(companyId, supplierId);
    const credit = await getSupplierOnAccountCredit(companyId, supplierId, fromDate);
    if (cents(credit.lowestFromDate) - cents(lowers) >= 0) continue;
    return { side: 'supplier', name: credit.supplierName, lowers: Math.round(lowers * 100) / 100, credit: credit.lowestFromDate, fromDate };
  }
  return null;
}

/** What the reallocation records next: a receipt for this customer re-adds the cash the old one's cancel removes. */
export interface ReallocationNext { target: ReallocationTarget; amount: number; date: string; autoApply?: AutoApplyMode }

/**
 * The cash a new receipt for the same customer keeps on account, as a floor: its whole amount when nothing is
 * auto-applied, else what is left after FIFO could take every open invoice of the customer (the most it can apply).
 */
export async function reallocationReAdd(companyId: string, next: ReallocationNext | undefined): Promise<CreditReAdd | undefined> {
  if (!next || next.target.kind !== 'customer' || next.amount <= 0) return undefined;
  const { customerId } = next.target;
  if ((next.autoApply ?? 'fifo') === 'none') return { customerId, date: next.date, amount: next.amount };
  const [r] = (await sql`
    SELECT COALESCE(SUM(GREATEST(ci.total_amount - COALESCE(ci.amount_paid, 0), 0)), 0) AS open
    FROM customer_invoices ci
    WHERE ci.company_id = ${companyId}::UUID AND COALESCE(ci.client_id, ci.customer_id) = ${customerId}::UUID
      AND ci.deleted_at IS NULL AND ci.status = ANY(${[...FIFO_ELIGIBLE_STATUSES]}::TEXT[])`) as DbRow[];
  return { customerId, date: next.date, amount: Math.max(next.amount - Number(r?.open ?? 0), 0) };
}

/**
 * Refuses (REALLOCATION_REFUSED, before any write) when cancelling the old documents would leave a refund uncovered.
 * Re-pointing a receipt to the SAME customer nets the new receipt's floor (`reallocationReAdd`) against what the
 * cancel removes; the unwind then runs inside the same judgment (`withReceiptCancellationsJudged`, the service).
 */
export async function assertReallocationKeepsCredit(
  companyId: string, old: { supplierPaymentIds: readonly string[]; customerPaymentIds: readonly string[] },
  reAdd?: CreditReAdd,
): Promise<void> {
  const customer = await customerVoidCreditShortfall(companyId, old.customerPaymentIds, reAdd);
  const s: Shortfall | null = customer
    ? { side: 'customer', name: customer.customerName, lowers: customer.lowers, credit: customer.credit, fromDate: customer.fromDate }
    : await supplierShortfall(companyId, old.supplierPaymentIds);
  if (!s) return;
  const doc = s.side === 'customer' ? 'receipt' : 'payment';
  throw new BankReallocationRefusal(`Reallocating this line would cancel its ${doc} and leave ${s.name} owing the company: `
    + `it takes ${formatMoney(s.lowers)} of unapplied cash off the ${s.side}'s account from ${s.fromDate}, and on some `
    + `date since then only ${formatMoney(Math.max(s.credit, 0))} is on account — a refund has already returned the rest. `
    + 'Reverse the refund first, then reallocate.');
}
