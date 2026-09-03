/**
 * Row-lock helpers for the customer- and supplier-payment WRITE paths.
 *
 * Applying cash to invoices is a check-then-act: read the payment's unapplied
 * remainder, refuse if the request exceeds it, then insert allocations and move
 * `amount_paid`. Two concurrent applications of one receipt both read the same
 * remainder, both pass, and both write — over-applying the receipt and
 * over-crediting the invoices. Nothing in the schema stops it: the unique index
 * on `(payment_id, invoice_id)` only catches the case where both name the SAME
 * invoice, and the interesting race is two agents applying one receipt to two
 * different invoices.
 *
 * The registry's idempotency replay does not help — a timed-out agent retries
 * with a FRESH key, which is exactly the caller that trips this.
 *
 * Mirrors `ar/creditNoteLock.ts` and `bank/bankTxLock.ts` deliberately: same
 * defect class, same remedy, same `lock_timeout` discipline. Since PR #264
 * every request runs inside one transaction on the AsyncLocalStorage-bound
 * client, so a `FOR UPDATE` taken here is held for the rest of the request.
 *
 * Write paths ONLY — never call these from a list or report service.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Raised when another request holds the payment row longer than the 5s
 * `lock_timeout`. The wording says "retry" because both the REST routes and the
 * MCP tools surface a caught service message straight to the caller, and a
 * lock timeout is the one refusal where retrying unchanged is the right move.
 */
export class PaymentLockTimeoutError extends Error {
  readonly code = 'PAYMENT_LOCK_TIMEOUT';
  constructor(paymentId: string) {
    super(`Payment ${paymentId} is being processed by another request — retry in a moment.`);
    this.name = 'PaymentLockTimeoutError';
  }
}

function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
}

function requireRequestTransaction(fnName: string): { query: (t: string) => Promise<unknown> } {
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

/**
 * Read one customer payment for a company, with its already-allocated total,
 * holding a row lock until the end of the surrounding transaction.
 *
 * Returns `null` when the row does not exist or belongs to another tenant —
 * callers keep their own not-found wording, so a cross-tenant probe reads
 * identically to a genuine miss.
 *
 * `allocated_amount` is read INSIDE the lock on purpose: it is the figure the
 * remainder check is made against, and reading it before the lock would leave
 * the same window the lock exists to close.
 */
export async function lockCustomerPaymentForUpdate(
  companyId: string,
  paymentId: string,
): Promise<DbRow | null> {
  const client = requireRequestTransaction('lockCustomerPaymentForUpdate');
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    const rows = (await sql`
      SELECT cp.*,
             COALESCE((
               SELECT SUM(cpa.amount_allocated)
               FROM customer_payment_allocations cpa
               WHERE cpa.payment_id = cp.id
             ), 0) AS allocated_amount
      FROM customer_payments cp
      WHERE cp.id = ${paymentId}::UUID AND cp.company_id = ${companyId}::UUID
      FOR UPDATE OF cp
    `) as DbRow[];
    // Restore the default on the SUCCESS path only. `SET LOCAL` lasts to the end
    // of the TRANSACTION, so without this the 5s budget silently governs every
    // lock taken afterwards in the same request. Deliberately NOT in a
    // `finally`: after a timeout the transaction is aborted and this statement
    // would itself throw 25P02, replacing the typed error with an opaque one.
    await client.query('SET LOCAL lock_timeout = DEFAULT');
    return rows[0] ?? null;
  } catch (err) {
    if (isLockTimeout(err)) throw new PaymentLockTimeoutError(paymentId);
    throw err;
  }
}

/**
 * Supplier half of `lockCustomerPaymentForUpdate` — same contract.
 *
 * `payment_allocations` is the LIVE allocation table on the AP side.
 * Migration 201's `supplier_payment_allocations` holds zero rows in dev and in
 * production, and every service writer and reader
 * (`supplierPaymentWorkflowService`, `batchPaymentService`) uses
 * `payment_allocations`. Reading the other one here would compute a remainder
 * from a table nothing posts against.
 */
export async function lockSupplierPaymentForUpdate(
  companyId: string,
  paymentId: string,
): Promise<DbRow | null> {
  const client = requireRequestTransaction('lockSupplierPaymentForUpdate');
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    const rows = (await sql`
      SELECT sp.*,
             COALESCE((
               SELECT SUM(pa.amount_allocated)
               FROM payment_allocations pa
               WHERE pa.payment_id = sp.id
             ), 0) AS allocated_amount
      FROM supplier_payments sp
      WHERE sp.id = ${paymentId}::UUID AND sp.company_id = ${companyId}::UUID
      FOR UPDATE OF sp
    `) as DbRow[];
    await client.query('SET LOCAL lock_timeout = DEFAULT');
    return rows[0] ?? null;
  } catch (err) {
    if (isLockTimeout(err)) throw new PaymentLockTimeoutError(paymentId);
    throw err;
  }
}
