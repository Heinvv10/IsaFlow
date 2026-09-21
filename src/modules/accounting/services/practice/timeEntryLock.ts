/**
 * Row-lock helper for the two paths that turn time entries into a customer
 * invoice (`practiceWipService.generateWipInvoice` and
 * `pages/api/accounting/time-entries-invoice.ts`).
 *
 * Both were check-then-act: they SELECTed the eligible entries
 * (`status='approved' AND billed_at IS NULL`, or `invoiced=false`), then minted
 * a real `customer_invoices` row with all its lines, then marked the entries
 * billed. Nothing serialised the two halves, so two concurrent generations over
 * the same entry ids both read them as eligible and both billed the client for
 * the same WIP — the loser's UPDATE matching zero rows, an outcome the caller
 * did not look at. The second invoice was linked to nothing and had to be
 * credit-noted.
 *
 * Locking the entries BEFORE the eligibility read is what makes the read
 * trustworthy: the loser parks here until the winner COMMITs, and its
 * eligibility SELECT then runs against a fresh snapshot in which the entries are
 * billed, so it refuses before the sequence is touched.
 *
 * Same shape and 5s timeout as recurringTemplateLock, bankTxLock and
 * supplierInvoiceLock, so every contended write path answers contention the
 * same way.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { als, assertTxUsable } from '@/lib/als';

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the row. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Raised when another request holds one of the selected time entries longer
 * than the 5s `lock_timeout`. Raised BEFORE the first write, so a route may
 * answer it with a 4xx without `withAuth` committing a partial invoice.
 */
export class TimeEntryLockTimeoutError extends Error {
  readonly code = 'TIME_ENTRY_LOCK_TIMEOUT';
  constructor() {
    super('These time entries are being invoiced by another request — retry in a moment.');
    this.name = 'TimeEntryLockTimeoutError';
  }
}

/**
 * Take a row lock on this company's copy of `ids` and hold it for the rest of
 * the request. Returns the ids actually locked (a cross-tenant or unknown id
 * simply does not come back — the caller's own eligibility read decides what
 * that means).
 *
 * Throws without a request transaction rather than locking nothing: outside one
 * every statement is its own implicit transaction and `FOR UPDATE` is released
 * the instant the SELECT returns, so the caller would believe two concurrent
 * generations are serialised when they are not.
 */
export async function lockTimeEntries(companyId: string, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      'Invoicing time entries requires a request transaction (withAuth / als.run). '
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }
  // Re-issued every call, never memoised: SET LOCAL is subtransaction-aware and
  // a savepoint rollback restores it to 0 — no timeout at all.
  assertTxUsable();
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    const rows = (await sql`
      SELECT id FROM time_entries
      WHERE id = ANY(${ids}::UUID[]) AND company_id = ${companyId}::UUID
      ORDER BY id
      FOR UPDATE
    `) as DbRow[];
    // Restored on the SUCCESS path only. After a timeout the transaction is
    // aborted and this statement would itself raise 25P02, replacing the typed
    // error with an opaque one. Left set, the 5s ceiling would leak onto every
    // later statement in the request.
    await client.query('SET LOCAL lock_timeout = DEFAULT');
    return rows.map((r) => String(r.id));
  } catch (err) {
    if (typeof err === 'object' && err !== null
      && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE) {
      throw new TimeEntryLockTimeoutError();
    }
    throw err;
  }
}

/**
 * Raised when the predicated UPDATE that marks the entries billed matched fewer
 * rows than were selected — i.e. something else claimed them between the read
 * and the write. The row count was previously discarded, which is how the
 * double-bill stayed silent; this makes it a 500 that rolls the invoice back.
 */
export class TimeEntriesNotClaimedError extends Error {
  readonly code = 'TIME_ENTRIES_NOT_CLAIMED';
  constructor(readonly expected: number, readonly claimed: number) {
    super(
      `Expected to mark ${expected} time entries billed but claimed ${claimed} — `
      + 'they were invoiced by another request.',
    );
    this.name = 'TimeEntriesNotClaimedError';
  }
}
