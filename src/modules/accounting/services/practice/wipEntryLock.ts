/**
 * Row-lock helper for the WIP → invoice write path.
 *
 * `generateWipInvoice` reads the approved, unbilled time entries in a selection
 * and then invoices them. Two overlapping runs used to both read the same entry
 * as unbilled — the second run's `markEntriesBilled` UPDATE then matched
 * nothing, and the same hours were billed on two invoices.
 *
 * `FOR UPDATE OF te` closes that window. Since every request runs in a single
 * transaction on the AsyncLocalStorage-bound client, the lock taken here is held
 * for the rest of the request: a second run blocks on the entry, and when the
 * first commits READ COMMITTED re-checks this statement's predicate against the
 * new row version. `billed_at` is set by then, so the entry drops out of the
 * selection before the second run writes anything at all.
 *
 * Write path ONLY — the WIP list queries must never take these locks.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { als, assertTxUsable } from '@/lib/als';

/**
 * Postgres `lock_not_available` (the 5s `lock_timeout` elapsed) and
 * `deadlock_detected`. Two runs whose selections overlap only partly can take
 * the same rows in different orders, which Postgres breaks as a deadlock rather
 * than a timeout — `lock_timeout` does not bound that. Both mean the same thing
 * to the caller: someone else has these entries, try again.
 */
const RETRYABLE_LOCK_ERRORS = new Set(['55P03', '40P01']);

/**
 * Raised when another run holds the selected entries longer than the 5s
 * `lock_timeout`, or when Postgres breaks a lock cycle between two overlapping
 * runs. The WIP route answers a caught service error's message as a 400, so
 * this wording is what the caller reads — it has to say "retry".
 */
export class WipEntriesLockedError extends Error {
  readonly code = 'WIP_ENTRIES_LOCKED';
  constructor() {
    super('The selected time entries are being invoiced by another request — retry in a moment.');
    this.name = 'WipEntriesLockedError';
  }
}

function isRetryableLockError(err: unknown): boolean {
  const code = typeof err === 'object' && err !== null
    ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && RETRYABLE_LOCK_ERRORS.has(code);
}

/**
 * Read the billable, approved, unbilled entries of a selection and hold a row
 * lock on each until the end of the surrounding transaction.
 *
 * Throws if no request transaction is in flight: outside one every statement is
 * its own implicit transaction, so `FOR UPDATE` releases the instant the SELECT
 * returns and the caller believes it is serialised when it is not.
 *
 * The 5s `lock_timeout` is re-issued on every call rather than memoised per
 * request — `SET LOCAL` is subtransaction-aware, so a `ROLLBACK TO SAVEPOINT`
 * would restore `0` (wait forever) exactly on the contended paths. Same
 * reasoning as `bank/bankTxLock.ts`.
 *
 * The timeout is transaction-scoped, so it also bounds the waits later in the
 * same request (the invoice INSERT, `markEntriesBilled`): a peer sitting on a
 * duplicate invoice number for more than 5s fails this run rather than parking
 * it behind an operator who has gone home. Deliberate, and the same trade
 * `bankTxLock.ts` makes.
 */
export async function lockEligibleWipEntries(
  companyId: string,
  practiceClientId: string,
  timeEntryIds: string[],
): Promise<DbRow[]> {
  const client = als.getStore()?.client;
  if (!client) {
    throw new Error(
      'lockEligibleWipEntries requires a request transaction (withAuth / als.run). '
      + 'Outside one, FOR UPDATE is released immediately and locks nothing.',
    );
  }
  assertTxUsable();
  await client.query("SET LOCAL lock_timeout = '5s'");
  try {
    return (await sql`
      SELECT te.id, te.hours, te.applied_rate, te.line_total,
        te.entry_date, te.task_description,
        te.work_item_id, te.job_category_id,
        pwi.name AS work_item_name,
        pjc.name AS job_category_name
      FROM time_entries te
      LEFT JOIN practice_work_items pwi
        ON pwi.id = te.work_item_id AND pwi.company_id = te.company_id
      LEFT JOIN practice_job_categories pjc
        ON pjc.id = te.job_category_id AND pjc.company_id = te.company_id
      WHERE te.id = ANY(${timeEntryIds}::UUID[])
        AND te.company_id = ${companyId}::UUID
        AND te.practice_client_id = ${practiceClientId}::UUID
        AND te.status = 'approved'
        AND te.billed_at IS NULL
        AND te.billable = true
        AND te.line_total IS NOT NULL
      FOR UPDATE OF te
    `) as DbRow[];
  } catch (err) {
    if (isRetryableLockError(err)) throw new WipEntriesLockedError();
    throw err;
  }
}
