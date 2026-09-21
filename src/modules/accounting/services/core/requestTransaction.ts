/**
 * The request-scoped client a `FOR UPDATE` needs to outlive its own statement.
 *
 * Since PR #264 every request runs inside one transaction on the
 * AsyncLocalStorage-bound client, so a `FOR UPDATE` taken on it is held for the
 * rest of the request. Outside one, Postgres runs the SELECT in its own
 * implicit transaction and releases the lock at the end of the statement — the
 * lock reads as taken and protects nothing, and a `SET LOCAL lock_timeout`
 * around it is discarded with the same transaction, leaving the default of 0 to
 * wait forever on a conflicting lock.
 *
 * So the no-transaction case is refused loudly rather than degraded silently.
 * `paymentLock`, `bankTxLock`, `creditNoteLock` and `supplierInvoiceLock` each
 * carry their own copy of this wording; new lock helpers import this one.
 */

import { als, assertTxUsable } from '@/lib/als';

export function requireRequestTransaction(fnName: string): { query: (t: string) => Promise<unknown> } {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      `${fnName} requires a request transaction (withAuth / als.run). `
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }
  assertTxUsable();
  return client as unknown as { query: (t: string) => Promise<unknown> };
}
