/**
 * The year-end close's period lock: judge, then lock, inside its write
 * transaction.
 *
 * The close reads "every period is closed" before it opens its transaction
 * (to answer the dry run and name open periods). That read is unlocked, so a
 * period reopened after it would still be locked by a blanket UPDATE. Here, on
 * the transaction's connection:
 *   1. every period of the year is row-locked in (fiscal_year, period_number,
 *      id) order, the order every period locker uses;
 *   2. the status is re-read from the locked rows: anything not `closed` or
 *      `locked` (a NULL status included) refuses the close;
 *   3. the readiness gate runs on every period about to be locked (periods
 *      closed before the gate existed, or changed since their close, are judged
 *      here before they are locked for good);
 *   4. only `closed` rows are updated, and the count must be the count judged.
 */

import type { TxSql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { assertYearCloseReady } from './periodCloseGate';

/** A period of the year was not closed when the close locked the year. */
export class YearEndPeriodsNotClosedError extends Error {
  readonly openPeriods: Array<{ id: string; periodName: string; periodNumber: number }>;
  constructor(openPeriods: Array<{ id: string; periodName: string; periodNumber: number }>) {
    super(`${openPeriods.length} period(s) of the year are not closed`);
    this.name = 'YearEndPeriodsNotClosedError';
    this.openPeriods = openPeriods;
  }
}

/** Not closed and not locked; NULL (mapped to anything else) counts as not closed. */
export const isSettledStatus = (status: unknown): boolean => status === 'closed' || status === 'locked';

/**
 * Steps 1-3. Returns the ids to lock. Throws YearEndPeriodsNotClosedError or
 * YearCloseBlockedError (action 'locked'); nothing is written.
 */
export async function lockAndJudgeYear(tx: TxSql, companyId: string, yearLabel: string): Promise<string[]> {
  const rows = (await tx`
    SELECT id, period_name, period_number, status FROM fiscal_periods
    WHERE company_id = ${companyId} AND fiscal_year = ${yearLabel}
    ORDER BY fiscal_year, period_number, id
    FOR NO KEY UPDATE
  `) as DbRow[];
  const open = rows.filter((r) => !isSettledStatus(r.status));
  if (open.length > 0) {
    throw new YearEndPeriodsNotClosedError(open.map((r) => ({
      id: String(r.id), periodName: String(r.period_name), periodNumber: Number(r.period_number),
    })));
  }
  const toLock = rows.filter((r) => r.status === 'closed').map((r) => ({ id: String(r.id), periodName: String(r.period_name) }));
  await assertYearCloseReady(companyId, Number(yearLabel), toLock, {}, 'locked');
  return toLock.map((p) => p.id);
}

/**
 * Step 4: lock the judged periods and report how many of the year's periods
 * are locked NOW (`periodsLockedInYear`), counted, not assumed. A judged row
 * that is no longer `closed` throws, and the transaction rolls back.
 */
export async function lockYear(tx: TxSql, companyId: string, yearLabel: string, judged: string[]): Promise<number> {
  const locked = judged.length === 0 ? [] : await tx`
    UPDATE fiscal_periods SET status = 'locked'
    WHERE company_id = ${companyId} AND fiscal_year = ${yearLabel}
      AND status = 'closed' AND id = ANY(${judged}::UUID[])
    RETURNING id
  `;
  if (locked.length !== judged.length) {
    throw new Error(`Year-end close: ${judged.length} periods were judged but ${locked.length} were locked`);
  }
  const total = (await tx`
    SELECT count(*)::int AS n FROM fiscal_periods
    WHERE company_id = ${companyId} AND fiscal_year = ${yearLabel} AND status = 'locked'
  `) as Array<{ n: number }>;
  return total[0]?.n ?? 0;
}
