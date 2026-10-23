/**
 * Make sure a journal date HAS a fiscal period, by creating the year on demand.
 *
 * The hole this closes: `createJournalEntry` resolves the covering
 * `fiscal_periods` row and, finding none, INSERTs `fiscal_period_id = NULL`.
 * `postJournalEntry` guards its closed-period check behind
 * `if (entry.fiscalPeriodId)`, so a NULL period skips it and the entry POSTS —
 * permanently outside the trial balance, the VAT201 and the AFS. Migration 501
 * names the cost: Britech's R267,109.70 salary understatement, with 200+ more
 * rows at the time. Those were backfilled and integrity check #9 now gates every
 * deploy, but the code path stayed open.
 *
 * ── HOW (since the change-of-year-end programme) ───────────────────────────
 *
 * The year comes from the fiscal-year registry (a stored `fiscal_years` row,
 * else the template) and is built by the one generator,
 * fiscalYearGenerator.generateFiscalYearForDate. A date in a GAP of an existing
 * year now gets its month's period too; a date in a closed or locked year
 * never does (the database refuses it, and the generator skips such a year),
 * and nor does a gap in a year holding closed or locked periods, which is
 * refused (FiscalPeriodNotGeneratedError) rather than posted with no period.
 *
 * ── WHY CREATE RATHER THAN REFUSE ───────────────────────────────────────────
 *
 * The root cause is not that createJournalEntry is permissive. It is that the
 * periods do not exist: `createFiscalYear` is reachable from exactly one manual
 * admin endpoint, nothing creates periods when a company is provisioned, and
 * there is no "create N years ahead". A brand-new company has ZERO periods, so
 * every date falls outside every one of them.
 *
 * Making createJournalEntry THROW would therefore break flows that work today —
 * bulk imports of historical books, payroll for a year nobody has created yet,
 * and every `new Date()` caller in the first days of an uncreated fiscal year.
 * Creating the period removes the reason dates fall outside at all, and breaks
 * nothing.
 *
 * ── THE BOUND IS THE LOAD-BEARING PART ──────────────────────────────────────
 *
 * Auto-creating whatever year a date names would build fiscal year 9999 out of a
 * typo. So creation is limited to a window around today: far enough back to
 * import a decade of old books, far enough forward for year-end and next-period
 * payroll, and nothing beyond. A date outside the window resolves to NULL
 * exactly as it does today — no worse than the status quo, and both the reversal
 * guard (resolveReversalDate) and the deploy-gating integrity check still catch
 * it.
 */

import { log } from '@/lib/logger';
import { isRealCalendarDate } from '@/lib/validation';
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { getFiscalPeriodIdForDate } from './fiscalPeriodService';
import { fiscalYearForDate } from './fiscalYearRegistry';
import { generateFiscalYearForDate } from './fiscalYearGenerator';
import { ClosedFiscalPeriodError } from './journalEntryPostingGuards';

/**
 * No period covers the date, and generating its fiscal year did not create one:
 * the generator adds no month to a year that already holds closed or locked
 * periods (migration 942), nor a part month at a year's edge. Refused, because
 * the null this used to return was stored as fiscal_period_id NULL and posted
 * past postJournalEntry's `if (entry.fiscalPeriodId)` closed-period check —
 * outside every period-bounded report. An IS-A ClosedFiscalPeriodError: the
 * remedy is the period's (create or re-open it), and every route that answers
 * a closed period with a 400 answers this one too.
 */
export class FiscalPeriodNotGeneratedError extends ClosedFiscalPeriodError {
  readonly code = 'FISCAL_PERIOD_NOT_GENERATED';
  constructor(
    entryDate: string,
    year: { fiscalYear: number; startDate: string; endDate: string } | null,
    holdsClosed: boolean,
    unresolved?: string,
  ) {
    super('closed');
    this.name = 'FiscalPeriodNotGeneratedError';
    const why = unresolved !== undefined || year === null
      ? `no financial year can be placed around it (${unresolved ?? 'unknown'})`
      : holdsClosed
      ? `fiscal year FY${year.fiscalYear} already holds closed or locked periods, and no month is added beside them`
      : `it falls in a part month at the edge of fiscal year FY${year.fiscalYear} (${year.startDate} to ${year.endDate}), `
        + 'which is never generated';
    this.message = `No fiscal period covers ${entryDate}, and none can be created for it: ${why}. `
      + `Create or re-open the period covering ${entryDate} before posting on it.`;
  }
}

/**
 * Does the generator refuse to fill this stored year? It does when the year
 * already holds a closed or locked period (fiscal_periods_generate, migration
 * 942), so a gap in it is not auto-creatable.
 */
export async function yearHoldsClosedPeriod(companyId: string, fiscalYearId: string): Promise<boolean> {
  const rows = (await sql`
    SELECT 1 FROM fiscal_periods
     WHERE company_id = ${companyId}::UUID AND fiscal_year_id = ${fiscalYearId}::UUID
       AND status IN ('closed', 'locked')
     LIMIT 1
  `) as DbRow[];
  return rows.length > 0;
}

/**
 * How far back a date may reach and still have its year created automatically.
 * Ten years covers a company migrating its full history — the oldest real bank
 * statement in this repo is from 2018 — without making a mistyped year plausible.
 */
export const AUTO_CREATE_YEARS_BACK = 10;

/**
 * How far forward. Two years covers year-end rollover and payroll or invoices
 * raised for the coming year, and stops well short of anything a typo produces.
 */
export const AUTO_CREATE_YEARS_FORWARD = 2;

export function isAutoCreatableYear(year: number, today: Date = new Date()): boolean {
  const current = today.getFullYear();
  return year >= current - AUTO_CREATE_YEARS_BACK && year <= current + AUTO_CREATE_YEARS_FORWARD;
}

/**
 * Outside the window by the calendar year alone, so the registry need not be
 * asked — and must not be: its year template chains at most 500 years from a
 * company's stored years and RAISES beyond that, which aborts the caller's
 * transaction even when the error is caught. A year chained forward is
 * labelled at least the calendar year of any day in it, one chained backward
 * at most the calendar year after, so a date for which neither is in the
 * window is outside it whatever the company's years look like (a typo'd 9999).
 */
export function isOutsideWindowByCalendarYear(date: string, today: Date = new Date()): boolean {
  const calendarYear = Number(date.slice(0, 4));
  return Number.isInteger(calendarYear)
    && !isAutoCreatableYear(calendarYear, today) && !isAutoCreatableYear(calendarYear + 1, today);
}

export interface EnsureOptions {
  /** Injected for tests; defaults to the real period lookup. */
  lookup?: (companyId: string, entryDate: string) => Promise<string | null>;
  today?: Date;
}

/**
 * The covering fiscal period's id for `entryDate`, generating its year (or the
 * missing month of an existing year) first when the year is inside the
 * auto-create window and not closed or locked.
 *
 * Returns null — exactly the previous behaviour — when the year is outside the
 * window, or closed or locked. Null is deliberately not an exception: this runs
 * on every journal write, and turning a previously-succeeding post into a throw
 * is the outcome the whole design set out to avoid. A NULL that reaches the
 * ledger is still detected by integrity check #9, which fails the post-deploy
 * gate.
 *
 * @throws FiscalPeriodNotGeneratedError when the year is inside the window and
 *   open but generating it still leaves the date uncovered (a gap beside closed
 *   periods). Before the generator, createFiscalYear refused such a year and
 *   that refusal was rethrown, so this throws where the old code threw.
 */
export async function ensureFiscalPeriodForDate(
  companyId: string,
  entryDate: string,
  opts?: EnsureOptions,
): Promise<string | null> {
  const lookup = opts?.lookup ?? getFiscalPeriodIdForDate;
  const existing = await lookup(companyId, entryDate);
  if (existing) return existing;

  if (isOutsideWindowByCalendarYear(entryDate, opts?.today)) {
    log.warn(
      'No fiscal period covers this date and its year is outside the auto-create window',
      { companyId, entryDate },
      'accounting',
    );
    return null;
  }

  // The FISCAL year the date falls in — the stored year that holds it, else the
  // template year the generator would create — never the calendar year read off
  // the date string, which on a March start is wrong ten months out of twelve.
  let year: Awaited<ReturnType<typeof fiscalYearForDate>>;
  try {
    year = await withSavepoint('ensure_fp_year', () => fiscalYearForDate(companyId, entryDate));
  } catch (err) {
    log.warn(
      'Could not resolve a fiscal year for this date',
      { companyId, entryDate, error: String(err) },
      'accounting',
    );
    // An unparseable date stays null (createJournalEntry's date guard answers
    // it). A real date the registry cannot place (a label the stored years
    // leave no room for) is refused: a null here would post the journal with
    // no period, past every closed-period check.
    if (!isRealCalendarDate(entryDate)) return null;
    throw new FiscalPeriodNotGeneratedError(entryDate, null, false, err instanceof Error ? err.message : String(err));
  }
  if (!isAutoCreatableYear(year.fiscalYear, opts?.today)) {
    log.warn(
      'No fiscal period covers this date and its year is outside the auto-create window',
      { companyId, entryDate, year: year.fiscalYear },
      'accounting',
    );
    return null;
  }
  if (year.status === 'closed' || year.status === 'locked') {
    log.warn(
      'No fiscal period covers this date and its fiscal year is closed',
      { companyId, entryDate, year: year.fiscalYear, status: year.status },
      'accounting',
    );
    return null;
  }

  // Concurrency is the generator's (ON CONFLICT DO NOTHING in the database):
  // the loser of a race reads the winner's year and periods without an error.
  const generated = await generateFiscalYearForDate(companyId, entryDate);
  if (generated.periodsCreated > 0) {
    log.info('Generated fiscal periods for a journal date', { companyId, year: year.fiscalYear, ...generated }, 'accounting');
  }

  // Re-read rather than trusting the generator, so the id always comes from the
  // same query the rest of the system resolves periods with.
  const covering = await lookup(companyId, entryDate);
  if (!covering) {
    throw new FiscalPeriodNotGeneratedError(
      entryDate, year, await yearHoldsClosedPeriod(companyId, generated.fiscalYearId));
  }
  return covering;
}
