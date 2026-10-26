/**
 * The refusal every void of a POSTED supplier payment makes before its first write (Hein's ruling 2026-10-26).
 *
 * Voiding cancels the payment, and its unapplied remainder (`total - allocated`, the term
 * `supplierOnAccountCredit` sums) leaves the supplier's on-account credit with it. When a refund has already
 * returned that cash, the credit goes below zero: the supplier owes the company, a receivable Accounts Payable cannot
 * hold (breaker REPRO 3 of #838). So a void that would take the credit below zero is refused, naming the refund.
 * A fully applied payment, or a refund being voided, takes nothing off the credit and is never refused here — a
 * supplier already below zero stays voidable that way.
 *
 * Judged on every date (`creditAllDates`), as an application is. Under the credit key (`supplierCreditLock`, tried,
 * never waited on — no edge in any wait-for cycle) when the void would lower the credit, so a refund in flight has
 * committed or is refused as retryable. A void that lowers nothing takes no key.
 *
 * The two writers that cancel a posted payment call this: `voidSupplierPayment` (payments screen) and
 * `bank/bankAllocationUnwind.unwindOnePayment` (bank reverse, chain reversal, MCP void_payment, run undo). A run
 * undo that reverses a payment and its refund together passes because it retries a refused row once the run's
 * other rows are done (`autoPostUndoRetry`). The batch reversal (its members) and the bank-first settlement void
 * (`provisionalSettlementVoid`, whose payment is wholly unapplied by then) call it too.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { lockSupplierCredit } from './supplierCreditLock';
import { getSupplierOnAccountCredit } from './supplierOnAccountCredit';
import { toCents } from './billAllocatable';
import { SupplierPaymentRefusal, isSupplierPaymentRefusal } from './supplierPaymentRefusal';

/** The credit refusal, told apart from the other supplier-payment refusals so a run undo can retry it last. */
export class SupplierVoidCreditRefusal extends SupplierPaymentRefusal {
  readonly reason = 'credit_ceiling' as const;
}

/** Structural, as `isSupplierPaymentRefusal` is. */
export function isVoidCreditRefusal(err: unknown): err is SupplierVoidCreditRefusal {
  return isSupplierPaymentRefusal(err) && (err as { reason?: unknown }).reason === 'credit_ceiling';
}

/** Refuses voiding `paymentIds` when it would take any of their suppliers' on-account credit below zero. */
export async function assertVoidKeepsCredit(companyId: string, paymentIds: readonly string[]): Promise<void> {
  if (paymentIds.length === 0) return;
  const rows = (await sql`
    SELECT sp.supplier_id,
           SUM(sp.total_amount - LEAST(COALESCE(alloc.allocated, 0), GREATEST(sp.total_amount, 0))) AS lowers
    FROM supplier_payments sp
    LEFT JOIN LATERAL (
      SELECT SUM(pa.amount_allocated) AS allocated FROM payment_allocations pa WHERE pa.payment_id = sp.id
    ) alloc ON TRUE
    WHERE sp.company_id = ${companyId}::UUID
      AND sp.id = ANY(${[...paymentIds]}::UUID[])
      AND sp.status IN ('processed', 'reconciled')
    GROUP BY sp.supplier_id
    ORDER BY sp.supplier_id
  `) as DbRow[];
  for (const r of rows) {
    const lowers = Number(r.lowers ?? 0);
    if (toCents(lowers) <= 0) continue;
    const supplierId = String(r.supplier_id);
    await lockSupplierCredit(companyId, supplierId);
    const { creditAllDates: credit, supplierName } = await getSupplierOnAccountCredit(companyId, supplierId, null);
    if (toCents(credit) - toCents(lowers) >= 0) continue;
    throw new SupplierVoidCreditRefusal(
      `Voiding this payment would leave ${supplierName} owing the company: it takes ${formatMoney(lowers)} of unapplied `
      + `cash off the supplier's account, and only ${formatMoney(Math.max(credit, 0))} is still on account — a refund `
      + 'has already returned the rest. Reverse the refund first, then void the payment.',
    );
  }
}
