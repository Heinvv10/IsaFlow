/**
 * Row-lock helper for the recurring-invoice RUN path.
 *
 * "Is this template active and due" is a check-then-act: two concurrent runs of
 * one template both passed the check and both posted, colliding only by luck on
 * the invoice-number unique index. Same shape and 5s timeout as bankTxLock,
 * creditNoteLock and supplierInvoiceLock, so every contended write path answers
 * contention the same way.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Raised when another request holds the template row longer than the 5s
 * `lock_timeout`. The routes surface a caught service error's message, so the
 * wording has to say "retry".
 */
export class RecurringInvoiceLockTimeoutError extends Error {
  readonly code = 'RECURRING_INVOICE_LOCK_TIMEOUT';
  constructor(recurringId: string) {
    super(`Recurring invoice ${recurringId} is being run by another request — retry in a moment.`);
    this.name = 'RecurringInvoiceLockTimeoutError';
  }
}

/**
 * Read the template and hold a row lock on it for the rest of the request.
 *
 * Throws without a request transaction rather than locking nothing: outside one
 * every statement is its own implicit transaction and `FOR UPDATE` is released
 * the instant the SELECT returns, so the caller would believe two concurrent
 * runs are serialised when they are not. Both production callers
 * (recurring-invoices-run.ts, recurring-invoices-action.ts) run under withAuth.
 */
export async function lockRecurringTemplate(companyId: string, id: string): Promise<DbRow | null> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      'generateInvoiceFromRecurring requires a request transaction (withAuth / als.run). '
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }
  // Re-issued every call, never memoised: SET LOCAL is subtransaction-aware and
  // a savepoint rollback restores it to 0 — no timeout at all.
  assertTxUsable();
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    const rows = (await sql`
      SELECT *, (next_run_date <= CURRENT_DATE) AS is_due
      FROM recurring_invoices
      WHERE id = ${id} AND company_id = ${companyId}
      FOR UPDATE
    `) as DbRow[];
    return rows[0] ?? null;
  } catch (err) {
    if (typeof err === 'object' && err !== null
      && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
      throw new RecurringInvoiceLockTimeoutError(id);
    }
    throw err;
  }
}

