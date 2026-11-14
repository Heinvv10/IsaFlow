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
 * RE-ENTRANT, and it says which: 'held' when this transaction already holds the row in a live (sub)transaction, so
 * the lock is a no-op; 'acquired' when this call took it. A savepoint rolled back releases a row lock taken inside it,
 * so a caller that cached a judgment made under the lock must treat 'acquired' as "the lock lapsed meanwhile" and judge
 * again. Told apart by the row's `xmax`: re-locking a row this transaction tree already holds at least as strongly
 * leaves it untouched; taking the lock writes a new one.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { PaymentLockTimeoutError } from '../core/paymentLock';

export type CustomerCreditLock = 'acquired' | 'held';

const xmaxOf = async (companyId: string, customerId: string): Promise<string | null> => {
  const [r] = (await sql`
    SELECT c.xmax::TEXT AS xmax FROM customers c
    WHERE c.id = ${customerId}::UUID AND c.company_id = ${companyId}::UUID`) as DbRow[];
  return r ? String(r.xmax) : null;
};

/** Take the customer row for the rest of the request, or refuse (retryable) when another request holds it. */
export async function tryLockCustomerCredit(companyId: string, customerId: string): Promise<CustomerCreditLock> {
  const before = await xmaxOf(companyId, customerId);
  if (before === null) return 'held'; // no such customer for this company: nothing to lock, nothing to contend
  const got = (await sql`
    SELECT c.id FROM customers c
    WHERE c.id = ${customerId}::UUID AND c.company_id = ${companyId}::UUID
    FOR NO KEY UPDATE OF c SKIP LOCKED`) as DbRow[];
  if (got.length === 0) {
    throw new PaymentLockTimeoutError(
      customerId,
      'A refund or another change to this customer\'s on-account credit is in progress — retry in a moment.',
    );
  }
  return (await xmaxOf(companyId, customerId)) === before ? 'held' : 'acquired';
}
