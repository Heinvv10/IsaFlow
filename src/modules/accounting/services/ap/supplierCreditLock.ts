/**
 * One supplier's ON-ACCOUNT CREDIT, serialised: every write that LOWERS it — a refund, an application of cash that
 * was already posted — holds this key from before it reads the figure to the end of the request.
 *
 * ── WHY (2026-10-25) ────────────────────────────────────────────────────────
 *
 * The credit (`getSupplierOnAccountCredit`) is a SUM over the supplier's posted payments minus their allocations.
 * A refund and an application each check it and then lower it, so each is a check-then-act on the same figure:
 *   · a refund planned while an application of the same cash was in flight read the uncommitted cash as still on
 *     account and refunded it (it waited only on the supplier row, which the application no longer touches once it
 *     writes each bill once);
 *   · an application checked only its OWN payment's remainder, so a refund taken first, then the application,
 *     left the supplier owing the company — a receivable on Accounts Payable;
 *   · two applications of different payments against one refund each read the credit before the other wrote.
 *
 * ── WHY A KEY NOBODY WAITS ON ───────────────────────────────────────────────
 *
 * The apply path cannot take the supplier row: PR #835 tried every mode before the payment and each crossed another
 * path (KEY SHARE: the journal-number lock + a refund's `FOR UPDATE`, approve/cancel refusals, a rule sweep;
 * NO KEY UPDATE: `processBatch`'s payee `FOR SHARE` + the journal number, the bank-file gate). And no WAITED lock
 * shared with the refund can work: one bank-rule sweep transaction can lock a bill (a payment-out line) and then
 * plan a refund, or plan a refund and then lock a bill, so an application that waited on the refund's lock before its
 * bills, or after them, closes a cycle with one order or the other.
 *
 * So the key is TRIED, never waited on (`pg_try_advisory_xact_lock`): it cannot be an edge in any wait-for cycle.
 * Held by another request means "an application or refund of this supplier's cash is in flight", and the caller is
 * refused with the retryable `PaymentLockTimeoutError` every one of these paths already answers 409/503 + retry,
 * before anything is written. The retry reads the committed figure. The key is re-entrant within one request (the
 * back-fill applies many sources of one supplier; `recordSupplierRefund` re-plans).
 *
 * WHO TAKES IT: `planSupplierPaymentApplication` for posted cash (REST supplier-allocations, MCP apply, the
 * back-fill) after its payment lock; `planSupplierRefund` after its supplier lock. An application of a payment
 * created in the same request (bank allocation, provisional settlement) lowers nothing — the payment and its
 * allocation land together — and does not take it. Unapply and void raise or remove credit and do not take it:
 * a refund reading a stale, lower figure refuses early, the safe direction.
 *
 * 64-bit `hashtextextended`, as every other key in this codebase.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { PaymentLockTimeoutError } from '../core/paymentLock';

const creditKey = (companyId: string, supplierId: string) =>
  `supplier_credit:${companyId.toLowerCase()}:${supplierId.toLowerCase()}`;

/** Take the supplier's credit key for the rest of the request, or refuse (retryable) when another request holds it. */
export async function lockSupplierCredit(companyId: string, supplierId: string): Promise<void> {
  const rows = (await sql`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${creditKey(companyId, supplierId)}, 0)) AS got`) as DbRow[];
  if (rows[0]?.got !== true) {
    throw new PaymentLockTimeoutError(
      supplierId,
      'Another payment application or refund for this supplier is in progress — retry in a moment.',
    );
  }
}
