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
import {
  createFiscalYear,
  getFiscalPeriodIdForDate,
  resolveCompanyPeriodAlignment,
} from './fiscalPeriodService';
import { fiscalYearOfDate } from './fiscalYearCalendar';

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

export interface EnsureOptions {
  /** Injected for tests; defaults to the real period lookup. */
  lookup?: (companyId: string, entryDate: string) => Promise<string | null>;
  today?: Date;
}

/**
 * The covering fiscal period's id for `entryDate`, creating that year first if
 * it does not exist and the year is inside the auto-create window.
 *
 * Returns null — exactly the previous behaviour — when the year is outside the
 * window, or when the period still cannot be resolved after creating it. Null is
 * deliberately not an exception: this runs on every journal write, and turning a
 * previously-succeeding post into a throw is the outcome the whole design set
 * out to avoid. A NULL that reaches the ledger is still detected by integrity
 * check #9, which fails the post-deploy gate.
 */
export async function ensureFiscalPeriodForDate(
  companyId: string,
  entryDate: string,
  opts?: EnsureOptions,
): Promise<string | null> {
  const lookup = opts?.lookup ?? getFiscalPeriodIdForDate;
  const existing = await lookup(companyId, entryDate);
  if (existing) return existing;

  // The FISCAL year the date falls in, not the calendar year and not the
  // current one. `Number(entryDate.slice(0, 4))` was the calendar year, which on
  // a March-start company is wrong for ten months out of twelve: a June 2026
  // date belongs to FY2027, and creating FY2026 builds Mar 2025 – Feb 2026 and
  // leaves the date uncovered exactly as before. The start month comes from
  // resolveCompanyPeriodAlignment, which follows the layout the company's existing
  // periods already use — so a tenant on calendar periods keeps getting calendar
  // years and nothing here half-migrates it.
  let year: number;
  try {
    const alignment = await resolveCompanyPeriodAlignment(companyId);
    year = fiscalYearOfDate(entryDate, alignment.startMonth);
  } catch (err) {
    // An unparseable date, or a company row that has gone. Null is the
    // pre-existing behaviour for a date no period covers; a throw here would
    // turn a journal that posts today into a 500.
    log.warn(
      'Could not resolve a fiscal year for this date',
      { companyId, entryDate, error: String(err) },
      'accounting',
    );
    return null;
  }
  if (!Number.isInteger(year) || !isAutoCreatableYear(year, opts?.today)) {
    log.warn(
      'No fiscal period covers this date and its year is outside the auto-create window',
      { companyId, entryDate, year },
      'accounting',
    );
    return null;
  }

  try {
    await createFiscalYear(companyId, year);
    log.info('Auto-created fiscal year for a journal date', { companyId, year }, 'accounting');
  } catch (err) {
    // Did we LOSE A RACE, or actually fail? Decided by the OUTCOME — does the
    // period exist now? — never by the error's text or its SQLSTATE.
    //
    // The first version matched /already exists/i, which is the message
    // createFiscalYear's own pre-check SELECT throws. A real race never
    // produces that: both pre-checks pass before either commits, and the
    // loser's INSERT dies on uq_fiscal_periods_company_year_period with a raw
    // 23505 ("duplicate key value violates unique constraint"). The overlap
    // EXCLUDE constraint from migration 502 raises 23P01, whose wording shares
    // nothing with either. Matching text would have turned the loser of a race
    // — whose journal is valid and whose period now EXISTS — into a 500, which
    // is worse than the silent NULL this module replaced.
    //
    // Enumerating 23505 and 23P01 would fix today's two shapes and rot on the
    // next one. This codebase already learned the message-matching half of the
    // lesson for invoice numbers (customerInvoiceCreateRetry.test.ts: "pg
    // localises/rewords messages"); asking whether the period exists answers
    // the actual question for every shape at once.
    const afterFailure = await lookup(companyId, entryDate);
    if (afterFailure) {
      log.info(
        'Lost the fiscal-year creation race; using the period the winner created',
        { companyId, year },
        'accounting',
      );
      return afterFailure;
    }
    // No period afterwards, so the failure was real. Rethrow the ORIGINAL error
    // — its code and message are the only diagnosis available.
    throw err;
  }

  // Re-read rather than trusting the create, so the id always comes from the
  // same query the rest of the system resolves periods with.
  return await lookup(companyId, entryDate);
}
