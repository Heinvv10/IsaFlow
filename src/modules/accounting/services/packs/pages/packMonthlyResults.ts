/**
 * PAGE 5 — THE RESULT MONTH BY MONTH, WHICH IS THE ONE VIEW OF IT NO OTHER
 * SHEET CARRIES.
 *
 * This page used to print Revenue, Gross profit, Operating profit, EBITDA and
 * Net profit against the prior period. Four of those five rows print again on
 * sheet 6, against the same comparative, with cost of sales and the two
 * below-the-line items added — so the sheet was 80% a shorter copy of the one
 * after it and ended at 48% of the paper. Two sheets printing one statement
 * twice is what an assembled deck does; a designed document gives each sheet
 * a question of its own.
 *
 * The question this one now answers is HOW THE PERIOD WAS EARNED OVER TIME.
 * Every figure comes from `PackTrendPoint` — the same series page 10 draws as
 * six small multiples — so a director who wants the numbers behind those
 * lines has them, and the two sheets cannot disagree about a month.
 *
 * EVERY ROW FOOTS ACROSS. `getPackTrend` defines a month's net profit as every
 * revenue account less every expense account, and bands both sides the way
 * `aggregateFigures` does — turnover and other income above, cost of sales,
 * the operating band and everything below the operating line below — so
 * `revenue + otherIncome − costOfSales − operating − other` IS the net profit
 * column to the cent, by construction rather than by assertion. That is the
 * whole reason the small bands are printed rather than folded away: without
 * them the reader adds the printed figures, misses by the band that was
 * hidden, and has no way to find out why.
 *
 * AND THE REVENUE COLUMN IS THE STATEMENT'S REVENUE. It was every revenue
 * account, other income included, while sheet 6's Revenue is turnover alone —
 * so Brightsphere printed (5 536) here and (5 535) one sheet later, the
 * other-income account to the rand, and only the window note stood between a
 * director and a contradiction it did not actually explain. `getPackTrend`
 * bands through `revenueBand`'s own alias table now; see `PackTrendPoint`.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is state a period total. The trend window
 * is twelve months ending at the reporting date and the pack's period is
 * whatever the caller asked for; a row labelled "Total" here would be a second
 * revenue figure for a second window, one sheet before the income statement's.
 * The last row states its own window in its own label, and the page's note
 * says which of the two the income statement uses.
 */

import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { PACK_SCALE } from './packBasis';
import { monthLabel } from './packPartialMonth';
import { COLUMNS, MEASURES, trendWindowLabel } from './packMonthlyMeasures';
import type { PackTable, PackTableRow } from './packPageModel';

/** The measure columns, the page's sentences and the EBITDA memorandum split
 *  to `packMonthlyMeasures.ts`, `packMonthlyCaption.ts` and
 *  `packEbitdaMemo.ts` for the 300-line cap. Re-exported because every
 *  existing caller imports them here. */
export { trendWindowLabel };
export {
  monthlyResultsTitle,
  monthlyResultsCaption,
  largestContraryFigureSentence,
} from './packMonthlyCaption';
export { ebitdaMemoSentence } from './packEbitdaMemo';

/**
 * Page 5's table: one row per month of the trend window, one column per
 * measure, and a closing row summing each column over the window.
 *
 * Empty where the series is — a table of no months is not a table, and the
 * page says so in words instead.
 */
export function buildMonthlyResultsTable(
  trend: PackTrendPoint[],
  p: PackFigureProvenance,
): PackTable {
  const rows: PackTableRow[] = trend.map((point) => ({
    label: monthLabel(point),
    level: 0,
    role: 'line',
    figures: Object.fromEntries(
      MEASURES.map((m) => [
        m.column,
        p.figure(`packTrendService.${point.month}.${m.field}`, m.read(point), 'money'),
      ]),
    ) as PackTableRow['figures'],
  }));

  if (trend.length > 0) {
    rows.push({
      label: trendWindowLabel(trend),
      level: 0,
      role: 'total',
      figures: Object.fromEntries(
        MEASURES.map((m) => [
          m.column,
          p.figure(
            `packMonthlyResults.window.${m.field}`,
            trend.reduce((sum, point) => sum + m.read(point), 0),
            'money',
          ),
        ]),
      ) as PackTableRow['figures'],
    });
  }

  return { scale: PACK_SCALE, columns: COLUMNS, rows };
}

/**
 * PAGE 5'S SHORT NAME IN THE CONTENTS, and the one string any sheet that
 * points a reader at this page may use.
 *
 * The page's own module owns the string, the way `MATTERS_NAV_LABEL` does,
 * so a sheet that ever points a reader here names the page the Contents
 * prints rather than a second spelling of it. Page 11's credit-month matter
 * wanted exactly that and could not afford the six characters — see
 * `packDerivedMatters.ts` — which is the reason this is here and used once:
 * the next pointer at this page should not have to re-derive the name.
 *
 * IT WAS "GROUP RESULTS", WHICH ASSERTED A BOUNDARY THIS PACK CANNOT SUPPORT.
 *
 * The word "group" appeared exactly twice in the document — this heading and
 * the contents line built from it — and was defined nowhere. Page 12 names
 * one source ledger and the cover names one `(Pty) Ltd`, so a reader had a
 * header claiming a consolidation over a basis page that neither confirmed
 * nor denied one; on a single entity that overstates the boundary, and on a
 * real group it is a consolidation policy that was never stated. Either way
 * the basis of preparation is incomplete, which is how the visual gate
 * scored it.
 *
 * The sheet is a month-by-month table of ONE entity's results — see
 * `buildMonthlyResultsTable`, one row per month of the trend series — so
 * "Monthly results" is what it has always been, and it asserts nothing the
 * pack does not print. The boundary itself is now STATED rather than merely
 * un-asserted: page 12 carries a `Reporting entity` fact naming the company
 * and saying the figures are not consolidated (`packFrontMatter.ts`), so
 * renaming the sheet is not a way of avoiding the question.
 *
 * TWO CHARACTERS LONGER, AND THAT IS PAID FOR. The contents index reserves
 * by measured label (`fitContentsPage`) and the running footer sets this
 * string at 7.5pt across the full measure; both are re-measured by
 * `packSheetCount` and `packPageFit` on every fixture.
 */
export const MONTHLY_RESULTS_NAV_LABEL = 'Monthly results';
