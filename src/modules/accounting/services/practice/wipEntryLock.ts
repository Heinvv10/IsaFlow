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

/** Postgres `lock_not_available` — `lock_timeout` elapsed waiting for the rows. */
const LOCK_NOT_AVAILABLE = '55P03';

/**
 * Raised when another run holds the selected entries longer than the 5s
 * `lock_timeout`. The WIP route answers a caught service error's message as a
 * 400, so this wording is what the caller reads — it has to say "retry".
 */
export class WipEntriesLockedError extends Error {
  readonly code = 'WIP_ENTRIES_LOCKED';
  constructor() {
    super('The selected time entries are being invoiced by another request — retry in a moment.');
    this.name = 'WipEntriesLockedError';
  }
}

function isLockTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === LOCK_NOT_AVAILABLE;
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
      LEFT JOIN practice_work_items pwi ON pwi.id = te.work_item_id
      LEFT JOIN practice_job_categories pjc ON pjc.id = te.job_category_id
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
    if (isLockTimeout(err)) throw new WipEntriesLockedError();
    throw err;
  }
}
