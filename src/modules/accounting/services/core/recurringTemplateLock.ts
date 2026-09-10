/**
 * Row-lock helper for the recurring-TEMPLATE run path (`executeRecurring`).
 *
 * "Is this template active and due" is a check-then-act, and until this file
 * existed `executeRecurring` did neither half: it read the row without
 * `FOR UPDATE` and never looked at `next_run_date` at all. What actually stopped
 * a repeat run was an accident — the month-constant `RINV-<slug>-<YYYYMM>`
 * number collided on `uq_customer_invoices_company_number`, so a second run in
 * the same month died. Moving the number onto the company sequence removed that
 * accident, and a double-click, a client retry or a re-POST would otherwise mint
 * a second real customer invoice and a second supplier bill, silently.
 *
 * Same shape and 5s timeout as recurringInvoiceLock, bankTxLock, creditNoteLock
 * and supplierInvoiceLock, so every contended write path answers contention the
 * same way.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Raised when another request holds the template row longer than the 5s
 * `lock_timeout`. Nothing has been written yet, but the 55P03 leaves the
 * transaction ABORTED, so this is answered 503 + `Retry-After` by
 * `apiDocumentLock` — the same as its three sibling lock-timeout classes, and
 * for the reason stated there: a 4xx would ask `withAuth` to COMMIT a
 * transaction that cannot commit, and a client retrying on 503 would not retry.
 */
export class RecurringTemplateLockTimeoutError extends Error {
  readonly code = 'RECURRING_TEMPLATE_LOCK_TIMEOUT';
  constructor(templateId: string) {
    super(`Recurring template ${templateId} is being run by another request — retry in a moment.`);
    this.name = 'RecurringTemplateLockTimeoutError';
  }
}

/**
 * Read the active template and hold a row lock on it for the rest of the request.
 *
 * `is_due` is computed in the same statement as the lock, so the answer cannot
 * be stale by the time the caller reads it. A NULL `next_run_date` counts as
 * due: the column is nullable and templates created without a schedule have to
 * stay runnable — the first run sets it, and from then on the guard bites.
 *
 * Throws without a request transaction rather than locking nothing: outside one
 * every statement is its own implicit transaction and `FOR UPDATE` is released
 * the instant the SELECT returns, so the caller would believe two concurrent
 * runs are serialised when they are not. The only production caller
 * (recurring-transactions-execute.ts) runs under withAuth.
 */
export async function lockRecurringTransactionTemplate(
  companyId: string,
  templateId: string,
): Promise<DbRow | null> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      'executeRecurring requires a request transaction (withAuth / als.run). '
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }
  // Re-issued every call, never memoised: SET LOCAL is subtransaction-aware and
  // a savepoint rollback restores it to 0 — no timeout at all.
  assertTxUsable();
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    const rows = (await sql`
      SELECT *, (next_run_date IS NULL OR next_run_date <= CURRENT_DATE) AS is_due
      FROM recurring_transaction_templates
      WHERE id = ${templateId}::UUID AND company_id = ${companyId} AND is_active = true
      FOR UPDATE
    `) as DbRow[];
    // Restored on the SUCCESS path only. After a timeout the transaction is
    // aborted and this statement would itself raise 25P02, replacing the typed
    // error with an opaque one. Left set, the 5s ceiling would leak onto every
    // later statement in the request and fail an unrelated write for reasons
    // that have nothing to do with it.
    await client.query('SET LOCAL lock_timeout = DEFAULT');
    return rows[0] ?? null;
  } catch (err) {
    if (typeof err === 'object' && err !== null
      && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
      throw new RecurringTemplateLockTimeoutError(templateId);
    }
    throw err;
  }
}
