/**
 * Bounded-wait wrapper for the `customer_invoices` row locks.
 *
 * Two write paths now take `FOR UPDATE` on an invoice: applying a credit note
 * to it, and planning a receipt allocation against it. Both need the same two
 * things the note and payment locks already have, and neither is optional:
 *
 *   1. A 5s `lock_timeout`. Without one the request waits forever on a row
 *      another request holds, while itself holding the credit-note or payment
 *      row — one stuck request becomes two.
 *   2. A typed error. The AR routes surface a caught service message straight
 *      to the caller, and a bare 55P03 reaches an agent as GENERIC_FAILURE,
 *      which does not read as retryable. This one says "retry".
 *
 * Mirrors `creditNoteLock.ts` / `core/paymentLock.ts` deliberately: same
 * discipline, same reasons, including why the DEFAULT is restored on the
 * success path only.
 *
 * The invoice is the LAST lock every path takes — note-then-invoice,
 * payment-then-invoice, bank-line-then-invoice — so it is a leaf and no
 * ordering cycle exists. Keep it that way: never take a note or payment lock
 * while holding one of these.
 */

import { als, assertTxUsable } from '@/lib/als';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/** Raised when another request holds an invoice row longer than the 5s budget. */
export class CustomerInvoiceLockTimeoutError extends Error {
  readonly code = 'CUSTOMER_INVOICE_LOCK_TIMEOUT';
  constructor(subject: string) {
    super(`${subject} is being processed by another request — retry in a moment.`);
    this.name = 'CustomerInvoiceLockTimeoutError';
  }
}

function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

/**
 * Run a `SELECT ... FOR UPDATE` over `customer_invoices` under a 5s
 * `lock_timeout`, mapping the timeout to a retryable typed error.
 *
 * @param fnName Caller name, for the "no request transaction" message.
 * @param subject What to name in the timeout message, e.g. `Invoice INV-1`.
 */
export async function withCustomerInvoiceLock<T>(
  fnName: string,
  subject: string,
  select: () => Promise<T>,
): Promise<T> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      `${fnName} requires a request transaction (withAuth / als.run). `
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }

  assertTxUsable();
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    const result = await select();
    // Success path ONLY. `SET LOCAL` lasts to the end of the TRANSACTION, so
    // leaving it set would put every later lock in the request on a 5s budget
    // and surface a bare 55P03 nothing maps. Not in a `finally`: after a lock
    // timeout the transaction is aborted and this statement would throw 25P02,
    // replacing the typed error with an opaque one.
    await client.query('SET LOCAL lock_timeout = DEFAULT');
    return result;
  } catch (err) {
    if (isLockTimeout(err)) throw new CustomerInvoiceLockTimeoutError(subject);
    throw err;
  }
}
