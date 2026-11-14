/**
 * The customer's refund lock, TRIED: what a receipt cancellation takes before it reads the customer's on-account
 * credit (`ar/customerVoidCredit`, 2026-11-14).
 *
 * A refund serialises on the customer row (`core/paymentLock.lockContactForRefund`, `FOR UPDATE`, waited) and then
 * reads the credit. A cancellation that lowers the same credit must meet it on that row, or a refund in flight reads
 * the receipt as still on account and a cancellation in flight reads the refund as not yet recorded.
 *
 * TRIED, never waited on (`SKIP LOCKED`), as the supplier credit key is (`ap/supplierCreditLock`): a bulk reversal
 * (`reverse_bank_allocation_batch` / `_range`, a run undo) reaches its second receipt's customer while it already
 * holds the journal-number lock its first reversal took, and a refund takes the customer and THEN the journal number;
 * a WAITED lock here closes that cycle. A tried one is no edge in any wait-for cycle. Held by another request (a
 * refund, a merge, another cancellation of this customer's cash) means the caller is refused with the retryable
 * `PaymentLockTimeoutError` (REST 503 + Retry-After, MCP retry, a run undo's contended skip), before any write; the
 * retry reads committed credit.
 *
 * `FOR NO KEY UPDATE`: it conflicts with the refund's `FOR UPDATE` (both directions) and with another cancellation, but
 * not with the `KEY SHARE` every uncommitted insert of an invoice or receipt for this customer holds through its FK —
 * those raise the credit or leave it alone, and refusing on them would refuse ordinary busy customers.
 * Re-entrant: a request that already holds the row (the reallocation's lock pass) takes it again.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { PaymentLockTimeoutError } from '../core/paymentLock';

/** Take the customer row for the rest of the request, or refuse (retryable) when another request holds it. */
export async function tryLockCustomerCredit(companyId: string, customerId: string): Promise<void> {
  const got = (await sql`
    SELECT c.id FROM customers c
    WHERE c.id = ${customerId}::UUID AND c.company_id = ${companyId}::UUID
    FOR NO KEY UPDATE OF c SKIP LOCKED`) as DbRow[];
  if (got.length > 0) return;
  // SKIP LOCKED answers a held row and a missing one alike; only a held one is contention.
  const exists = (await sql`
    SELECT 1 AS one FROM customers c WHERE c.id = ${customerId}::UUID AND c.company_id = ${companyId}::UUID`) as DbRow[];
  if (exists.length === 0) return;
  throw new PaymentLockTimeoutError(
    customerId,
    'A refund or another change to this customer\'s on-account credit is in progress — retry in a moment.',
  );
}
