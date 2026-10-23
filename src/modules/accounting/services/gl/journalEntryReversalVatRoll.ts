/**
 * Rolling a reversal's DEFAULT date past locked VAT periods.
 *
 * A reversal with no date named defaults to the original entry's date (or to
 * today when that fiscal period is not open — see journalEntryReversalDate for
 * the future-dated cases). When
 * the original moves a VAT-return figure and that default lands inside an
 * ACTIVE VAT lock, posting the contra there would change a VAT201 already
 * filed. Reversals are the one posting the lock does not simply refuse: the
 * contra rolls FORWARD to the earliest date >= the default that is outside
 * every active lock AND inside an open fiscal period, and the caller is told it
 * rolled. Nothing up to today → refuse with VatPeriodLockedError.
 *
 * "Open" is the same test getPeriodStatusForDate makes — a covering
 * fiscal_periods row whose status is 'open' — PLUS the case createJournalEntry
 * itself treats as open: a date NO row covers whose fiscal-year-registry year
 * ensureFiscalPeriodForDate would generate a period in on demand (the year's
 * label inside the auto-create window, the year not closed or locked) — see
 * makeAutoCreatable. A date covered by a closed/locked row is not postable;
 * neither is an uncovered date outside the auto-create window.
 *
 * Its own file to keep journalEntryReversalDate inside the 300-line cap.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { isAutoCreatableYear } from './fiscalPeriodAutoCreate';
import { fiscalYearForDate } from './fiscalYearRegistry';
import { isLedgerDate } from './ledgerDateRange';
import {
  VatPeriodLockedError,
  findActiveVatLock,
  journalMovesVatFigure,
  type VatLineRef,
} from './journalVatLockGuard';

export interface DateRange {
  start: string;
  end: string;
}

/** What a rolled reversal reports: where it would have gone, where it went, and why. */
export interface VatLockRoll {
  rolledFrom: string;
  date: string;
  lockedPeriodStart: string;
  lockedPeriodEnd: string;
  reason: string;
}

type Row = Record<string, unknown>;

function nextDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

export interface PeriodRange extends DateRange {
  open: boolean;
}

/**
 * The earliest date in [from, ceiling] outside every lock and postable, or
 * null. Postable: inside an OPEN period, or inside no period at all when
 * `autoCreatable(date)` says createJournalEntry would create that date's period.
 * Every range is inclusive at both ends, and ISO dates compare as strings.
 */
export async function earliestPostableDate(
  from: string, ceiling: string, locks: readonly DateRange[], periods: readonly PeriodRange[],
  autoCreatable: (date: string) => boolean | Promise<boolean> = () => false,
): Promise<string | null> {
  let d = from;
  // Each pass either returns or moves `d` strictly forward — past a lock, past
  // a non-open period, or to the next period's start — so it terminates.
  for (let guard = 0; guard <= 2 * (locks.length + periods.length) + 2; guard++) {
    if (d > ceiling) return null;
    const lock = locks.find((l) => l.start <= d && l.end >= d);
    if (lock) { d = nextDay(lock.end); continue; }
    const covering = periods.find((p) => p.start <= d && p.end >= d);
    if (covering) {
      if (covering.open) return d;
      d = nextDay(covering.end);
      continue;
    }
    if (await autoCreatable(d)) return d;
    const next = periods.filter((p) => p.start > d).map((p) => p.start).sort()[0];
    if (!next) return null;
    d = next;
  }
  return null;
}

/**
 * Would ensureFiscalPeriodForDate create a period for this uncovered date?
 * Exactly its conditions: the registry year holding the date (a stored year,
 * else the template year) has its label inside the auto-create window and is
 * not closed or locked. A date in a GAP of an existing open year is postable:
 * the generator now fills the missing month, and there is no overlap refusal.
 * An unparseable date answers false, as ensureFiscalPeriodForDate answers NULL.
 * `today` is injectable for tests.
 */
export function makeAutoCreatable(
  companyId: string, today: Date = new Date(),
): (date: string) => Promise<boolean> {
  return async (date: string) => {
    if (!isLedgerDate(date)) return false;
    let year: Awaited<ReturnType<typeof fiscalYearForDate>>;
    try {
      year = await fiscalYearForDate(companyId, date);
    } catch {
      // No fiscal year resolvable (a company row that has gone): ensureFiscalPeriodForDate
      // answers NULL for exactly this failure, so no uncovered date is postable.
      return false;
    }
    return isAutoCreatableYear(year.fiscalYear, today) && year.status !== 'closed' && year.status !== 'locked';
  };
}

/**
 * Would posting on `date` create its period on demand (R-012)? The same
 * predicate the roll uses.
 */
export async function isDateAutoCreatable(companyId: string, date: string): Promise<boolean> {
  return makeAutoCreatable(companyId)(date);
}

/**
 * Is `date`'s fiscal year outside the auto-create window (R-012)? A typo'd
 * year such as 9999: posting never creates it. Distinct from "not
 * auto-creatable", which also covers a closed or locked year. When the year
 * cannot be resolved the answer is unknown: false — which makes the resolver
 * REFUSE even a typo'd-year entry. Deliberate: failing closed.
 */
export async function isOutsideAutoCreateWindow(companyId: string, date: string): Promise<boolean> {
  if (!isLedgerDate(date)) return false;
  try {
    const year = await fiscalYearForDate(companyId, date);
    return !isAutoCreatableYear(year.fiscalYear);
  } catch {
    return false; // unknown year: not provably a typo'd year
  }
}

/**
 * `defaultDate`, or the date it rolls to. `roll` is null when nothing rolled:
 * no active lock covers the default, or the journal moves no VAT figure.
 */
export async function rollDefaultReversalDate(
  companyId: string, defaultDate: string, lines: readonly VatLineRef[],
): Promise<{ date: string; roll: VatLockRoll | null }> {
  const lock = await findActiveVatLock(companyId, defaultDate);
  if (!lock || !(await journalMovesVatFigure(companyId, lines))) return { date: defaultDate, roll: null };

  // fmtDate, not toISOString: between 00:00 and 02:00 SAST the latter is yesterday.
  const today = fmtDate(new Date());
  const ceiling = defaultDate > today ? defaultDate : today;
  const lockRows = (await sql`
    SELECT period_start, period_end FROM vat_period_locks
    WHERE company_id = ${companyId}::UUID AND unlocked_at IS NULL
      AND period_end >= ${defaultDate}::DATE AND period_start <= ${ceiling}::DATE`) as Row[];
  const periodRows = (await sql`
    SELECT start_date, end_date, status FROM fiscal_periods
    WHERE company_id = ${companyId}::UUID`) as Row[];
  const range = (a: unknown, b: unknown): DateRange => ({ start: fmtDate(a as string), end: fmtDate(b as string) });
  const periods = periodRows.map((r) => ({
    ...range(r.start_date, r.end_date), open: String(r.status) === 'open',
  }));
  const date = await earliestPostableDate(
    defaultDate, ceiling,
    lockRows.map((r) => range(r.period_start, r.period_end)),
    periods.filter((p) => p.end >= defaultDate && p.start <= ceiling),
    makeAutoCreatable(companyId),
  );
  if (!date) {
    throw new VatPeriodLockedError(defaultDate, lock, undefined,
      `Cannot reverse: the reversal would be dated ${defaultDate}, inside the locked VAT period `
      + `${lock.periodStart} to ${lock.periodEnd} (its VAT201 has been filed), and no date from then up to `
      + `${ceiling} is both outside every locked VAT period and in an open fiscal period to move it to. `
      + 'An owner or admin can unlock that period (with a reason) if the return is being amended, or the '
      + 'reversal can be made once a date after the lock is open.');
  }
  return {
    date,
    roll: {
      rolledFrom: defaultDate,
      date,
      lockedPeriodStart: lock.periodStart,
      lockedPeriodEnd: lock.periodEnd,
      reason: `${defaultDate} is inside the locked VAT period ${lock.periodStart} to ${lock.periodEnd} `
        + `(its VAT201 has been filed), so the reversal is dated ${date}, the first date after it that is `
        + 'outside every locked VAT period and in an open fiscal period.',
    },
  };
}
