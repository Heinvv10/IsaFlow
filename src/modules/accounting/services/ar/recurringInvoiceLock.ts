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
  constructor(recurringId: string, action: 'run' | 'edit' = 'run') {
    super(action === 'edit'
      ? `Recurring invoice ${recurringId} is locked by another request (a run or another edit) — retry the edit in a moment.`
      : `Recurring invoice ${recurringId} is being run by another request — retry in a moment.`);
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
export async function lockRecurringTemplate(
  companyId: string, id: string, action: 'run' | 'edit' = 'run',
): Promise<DbRow | null> {
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
      SELECT ri.*, (ri.next_run_date <= CURRENT_DATE) AS is_due,
             c.payment_terms AS contact_payment_terms, c.payment_terms_type AS contact_payment_terms_type,
             d.value AS company_default_terms
      FROM recurring_invoices ri
      LEFT JOIN accounting_settings d ON d.company_id = ri.company_id AND d.key = 'default_payment_terms'
      LEFT JOIN customers c ON c.id = ri.client_id AND c.company_id = ri.company_id
      WHERE ri.id = ${id} AND ri.company_id = ${companyId}
      FOR UPDATE OF ri
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
      throw new RecurringInvoiceLockTimeoutError(id, action);
    }
    throw err;
  }
}

