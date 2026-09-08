/**
 * Pre-write fiscal-period verdicts for the bulk approve tools.
 *
 * ── WHY THIS IS ANSWERED BEFORE THE WRITE ───────────────────────────────────
 *
 * `ClosedFiscalPeriodError` is raised inside `postJournalEntry` — AFTER
 * `createJournalEntry` has already inserted the draft journal row. So by the
 * time the period is discovered to be closed, the element has written. That
 * makes it useless as a skip signal: the only shape available there is a throw,
 * and under the batch rules a throw fails all 100 invoices.
 *
 * A closed period is not a fault in what the agent SENT. It is a routine
 * property of a drafted backlog that straddles a period close — exactly the
 * shape of the subledger reload these tools exist for. One stale date must not
 * cost the other 99 postings. So the period is resolved here, read-only, on the
 * same pass that answers `dry_run`, and a closed one is SKIPPED.
 *
 * If a period closes between this read and the post, `ClosedFiscalPeriodError`
 * still escapes and still fails the batch. That is deliberate: it means the
 * pre-check was raced, and failing loudly beats pretending it was covered.
 *
 * ── THE TRAP THIS MODULE EXISTS TO AVOID ────────────────────────────────────
 *
 * The obvious implementation is "resolve the covering period; no period → skip".
 * That guard is wrong in the other direction. `createJournalEntry` calls
 * `ensureFiscalPeriodForDate`, which CREATES the fiscal year on demand when the
 * date falls inside a bounded window around today. An invoice dated in an
 * uncreated-but-creatable year posts perfectly well today; skipping it would
 * refuse work the single tool performs, and a subledger reload of historical
 * books is precisely the caller that hits uncreated years.
 *
 * So there are three verdicts, not two:
 *
 *   - a period covers the date and is open        → postable
 *   - a period covers the date and is not open    → SKIP (closed/locked)
 *   - no period covers the date                   → postable IF the date's
 *     FISCAL year is inside the auto-create window (it will be created open),
 *     otherwise SKIP
 *
 * That last skip is the NULL-`fiscal_period_id` case. `ensureFiscalPeriodForDate`
 * returns null outside the window, `createJournalEntry` stores NULL, and
 * `postJournalEntry` guards its closed-period check behind
 * `if (entry.fiscalPeriodId)` — so the entry POSTS, permanently outside the
 * trial balance, the VAT201 and the AFS. Migration 501 priced that at
 * R267,109.70 on one tenant. Integrity check #9 catches it after the fact and
 * fails the next deploy's post-deploy gate; refusing the line here is cheaper
 * than a red gate and a correcting journal.
 *
 * ── ONE QUERY ───────────────────────────────────────────────────────────────
 *
 * Every period the company owns is read once and matched in JS, rather than one
 * lookup per element. A batch of 100 invoices carries up to 100 distinct dates,
 * and a company holds a few dozen periods — so the whole table is smaller than
 * the per-date queries it replaces, and it keeps the savepoint loop free of
 * reads.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { isAutoCreatableYear } from '@/modules/accounting/services/gl/fiscalPeriodAutoCreate';
import {
  resolveCompanyPeriodAlignment,
} from '@/modules/accounting/services/gl/fiscalYearCreateService';
import { fiscalYearOfDate } from '@/modules/accounting/services/gl/fiscalYearCalendar';
import { fmtDate } from '@/lib/fmtDate';

/** A period row, reduced to what the verdict depends on. */
interface PeriodWindow {
  startDate: string;
  endDate: string;
  status: string;
}

/**
 * Why this element's date cannot post, or `null` when it can.
 *
 * The string is the agent-facing skip reason, so it names the date and the
 * period status — an agent told only "period problem" cannot tell a closed
 * month from a year nobody has created.
 */
export type PeriodSkipReason = string | null;

/**
 * Resolves each supplied date to a verdict, keyed by the date as given.
 *
 * Dates are normalised with `fmtDate` (local components) rather than
 * `toISODate`: on this UTC+2 server a `Date` at local midnight rolls BACK a day
 * under UTC, which resolves the wrong period at every month boundary — the same
 * bug `getFiscalPeriodIdForDate` documents. `pg` hands back `timestamp` columns
 * as `Date` objects, so both sides of the comparison go through it.
 */
export async function resolvePeriodSkips(
  companyId: string,
  dates: readonly (string | Date)[],
): Promise<Map<string, PeriodSkipReason>> {
  const verdicts = new Map<string, PeriodSkipReason>();
  if (dates.length === 0) return verdicts;

  const rows = (await sql`
    SELECT start_date, end_date, status
    FROM fiscal_periods
    WHERE company_id = ${companyId}::UUID
    ORDER BY start_date
  `) as DbRow[];
  const periods: PeriodWindow[] = rows.map((r) => ({
    startDate: fmtDate(r.start_date as string | Date),
    endDate: fmtDate(r.end_date as string | Date),
    status: String(r.status),
  }));

  // Read once for the whole batch, and only when some date actually falls
  // outside every period — the alignment lookup is a query of its own, and the
  // common batch (every date inside an existing period) must not pay for it.
  let startMonth: number | null = null;
  const fiscalYearStartMonth = async (): Promise<number> => {
    if (startMonth === null) {
      startMonth = (await resolveCompanyPeriodAlignment(companyId)).startMonth;
    }
    return startMonth;
  };

  for (const raw of dates) {
    const date = fmtDate(raw);
    if (verdicts.has(date)) continue;

    const covering = periods.find((p) => date >= p.startDate && date <= p.endDate);
    if (covering) {
      verdicts.set(
        date,
        covering.status === 'open'
          ? null
          : `fiscal period covering ${date} is ${covering.status} — reopen it or re-date the document`,
      );
      continue;
    }

    // No period covers the date. That is NOT automatically a skip — see the
    // header: the year is created on demand inside a bounded window, and a
    // historical reload routinely names years nobody has created yet. The
    // FISCAL year is what the window is tested against, not the calendar year:
    // on a March-start company a June 2026 date belongs to FY2027, and testing
    // the calendar year is wrong for ten months out of twelve.
    const year = fiscalYearOfDate(date, await fiscalYearStartMonth());
    verdicts.set(
      date,
      isAutoCreatableYear(year)
        ? null
        : `no fiscal period covers ${date} and fiscal year ${year} is outside the auto-create window `
          + '— create the year first, or the journal would post with no period and stay outside '
          + 'the trial balance',
    );
  }

  return verdicts;
}
