/**
 * The customer's refund lock, TRIED: what every write that removes unapplied receipt cash takes before it reads the
 * customer's running on-account credit (`ar/customerVoidCredit`) — a cancellation, an application of an existing
 * receipt's remainder.
 *
 * A refund serialises on the customer row (`core/paymentLock.lockContactForRefund`, `FOR UPDATE`, waited) and then
 * reads the credit. A write that lowers the same credit must meet it on that row, or each reads the other as not yet
 * written.
 *
 * WHERE: after the receipt row and the invoices the write touches, before any write and any journal — the canonical
 * payments → invoices → customers that the customer merge and the reallocation lock pass take.
 *
 * WHY TRIED (`SKIP LOCKED`): this path never WAITS on the customer, so it adds no wait for the customer to any cycle.
 * Held by another request → the retryable `PaymentLockTimeoutError` (REST 503 + Retry-After, MCP retry, a run undo's
 * contended skip), before any write. Once held, the holder may still wait on other rows; the cycles that closes are
 * listed in `ar/.claude.md` (each a retryable 40P01).
 *
 * `FOR NO KEY UPDATE`: it conflicts with the refund's `FOR UPDATE` (both directions) and with another writer's own
 * tried lock, but not with the `KEY SHARE` every uncommitted insert of an invoice or receipt for this customer holds
 * through its FK — those raise the credit or leave it alone, and refusing on them would refuse ordinary busy
 * customers.
 *
 * A write that LOWERS the credit, naming a customer not found in this company, is REFUSED (fail closed), never treated
 * as nothing to lock. A write that lowers nothing takes no lock and is not asked.
 * Re-entrant: a request that already holds the row (the reallocation's lock pass, an earlier receipt of the same
 * customer) takes it again as a no-op.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { PaymentLockTimeoutError } from '../core/paymentLock';
import { ReceiptRefusal } from './receiptRefusal';

/** Take the customer row for the rest of the request, or refuse (retryable) when another request holds it. */
export async function tryLockCustomerCredit(companyId: string, customerId: string): Promise<void> {
  const got = (await sql`
    SELECT c.id FROM customers c
    WHERE c.id = ${customerId}::UUID AND c.company_id = ${companyId}::UUID
    FOR NO KEY UPDATE OF c SKIP LOCKED`) as DbRow[];
  if (got.length > 0) return;
  // SKIP LOCKED answers a held row and a missing one alike: a missing one fails closed, a held one is contention.
  await assertCustomerOfCompany(companyId, customerId);
  throw new PaymentLockTimeoutError(
    customerId,
    'A refund or another change to this customer\'s on-account credit is in progress — retry in a moment.',
  );
}

/**
 * FAIL CLOSED: a write that lowers the credit of a customer that is not this company's (`client_id` is an FK on id
 * only) has no credit here to judge and no row to serialise a refund on — refused by name, never passed as "nothing to
 * lock". The unlocked bulk
 * judgment (a dry run) asks this too, so it refuses what the live call will.
 */
export async function assertCustomerOfCompany(companyId: string, customerId: string): Promise<void> {
  const exists = (await sql`
    SELECT 1 AS one FROM customers c WHERE c.id = ${customerId}::UUID AND c.company_id = ${companyId}::UUID`) as DbRow[];
  if (exists.length === 0) {
    throw new ReceiptRefusal('This receipt names a customer that is not one of this company\'s customers — nothing '
      + 'was changed. Correct the receipt\'s customer first.');
  }
}
