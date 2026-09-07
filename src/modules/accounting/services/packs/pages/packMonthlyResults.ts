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

import { formatMoney, inProse, MONEY_SCALES, type MoneyScale } from '@/lib/format/money';
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import { toFinancialData } from './packScorecard';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { PACK_SCALE } from './packBasis';
import type { PackTable, PackTableColumnKey, PackTableRow } from './packPageModel';

/** The five measure columns, in the order they print. */
const COLUMNS: readonly PackTableColumnKey[] = [
  'revenue',
  'otherIncome',
  'costOfSales',
  'monthOperatingExpenses',
  'otherExpenses',
  'netProfit',
] as const;

/** The below-the-operating-line band of a month's expenses.
 *
 *  Derived by DIFFERENCE, not fetched: `getPackTrend` computes
 *  `operatingExpenses = expenses − costOfSales − belowOperatingLine` and
 *  rounds it, so the difference taken back out is the only figure that makes
 *  the printed row add up. A second read of the band would round separately
 *  and put a cent between the four columns and the fifth. */
function otherExpensesOf(point: PackTrendPoint): number {
  return point.expenses - point.costOfSales - point.operatingExpenses;
}

const MEASURES: ReadonlyArray<{
  column: PackTableColumnKey;
  field: string;
  read: (p: PackTrendPoint) => number;
}> = [
  { column: 'revenue', field: 'revenue', read: (p) => p.revenue },
  { column: 'otherIncome', field: 'otherIncome', read: (p) => p.otherIncome },
  { column: 'costOfSales', field: 'costOfSales', read: (p) => p.costOfSales },
  { column: 'monthOperatingExpenses', field: 'operatingExpenses', read: (p) => p.operatingExpenses },
  { column: 'otherExpenses', field: 'otherExpenses', read: otherExpensesOf },
  { column: 'netProfit', field: 'netProfit', read: (p) => p.netProfit },
];

/** What the closing row is called — its own window, never "Total". See the
 *  header: the pack's period is a different window and prints its own totals
 *  on the next sheet. */
export function trendWindowLabel(trend: PackTrendPoint[]): string {
  const last = trend[trend.length - 1]!;
  const months = trend.length === 1 ? '1 month' : `${trend.length} months`;
  return `${months} to ${last.label}`;
}

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
    label: point.label,
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
 * Page 5's title — a conclusion about the twelve months, not a label.
 *
 * It names the best and the worst month for net profit, which is the one
 * thing a month-by-month table says that a period statement cannot. Where
 * every month is the same figure there is no spread to name and the sentence
 * states the level instead, the same rule `movementSentence` follows.
 */
export function monthlyResultsTitle(trend: PackTrendPoint[], scale: MoneyScale): string {
  // A DIGIT, because `assertPageTitleIsAMessage` refuses a bare label — and
  // the count is the fact anyway: none of the months could be built.
  if (trend.length === 0) return 'No monthly series covers this period, so 0 months are shown.';
  const money = (n: number) => inProse(formatMoney(n, { scale }));
  const best = trend.reduce((a, b) => (b.netProfit > a.netProfit ? b : a));
  const worst = trend.reduce((a, b) => (b.netProfit < a.netProfit ? b : a));
  const months = trend.length === 1 ? 'the one month' : `the ${trend.length} months`;
  if (best.netProfit === worst.netProfit) {
    return `Net profit is ${money(best.netProfit)} in every one of ${months} shown.`;
  }
  // A MONTH IS NAMED ONLY WHERE IT IS THE ONLY ONE AT THAT FIGURE. On
  // Brightsphere eleven of the twelve months are nil, and naming whichever of
  // them the reduction happened to reach — "to nil in Oct 2025" — presents an
  // arbitrary tie-break as a fact about October. The count is the fact, and a
  // range is not the sentence to state it in: "runs from … to …" describes a
  // spread, and a year with one posted month has a level and an exception.
  const at = (value: number) => trend.filter((point) => point.netProfit === value).length;
  const bestAt = at(best.netProfit);
  const worstAt = at(worst.netProfit);
  if (bestAt === 1 && worstAt === 1) {
    return `Net profit runs from ${money(worst.netProfit)} in ${worst.label} to `
      + `${money(best.netProfit)} in ${best.label} across ${months}.`;
  }
  const side = (point: PackTrendPoint, count: number) => (count === 1
    ? `${money(point.netProfit)} in ${point.label}`
    : `${money(point.netProfit)} in ${count} of ${months}`);
  return `Net profit is ${side(worst, worstAt)} and ${side(best, bestAt)}.`;
}

/**
 * The page's caption — how much of the window's revenue one month carried.
 *
 * Checkable off the table beside it: the month's revenue and the window's
 * revenue are both printed. Null where the window's revenue is not a positive
 * base, which is Brightsphere: a share of a negative turnover is not a
 * measurement, and the pack's rule everywhere else is to say so rather than
 * print a flattering percentage.
 */
export function monthlyResultsCaption(trend: PackTrendPoint[], scale: MoneyScale): string {
  if (trend.length === 0) {
    return 'No monthly series covers this period, so nothing is stated about its shape.';
  }
  const money = (n: number) => inProse(formatMoney(n, { scale }));
  const window = trendWindowLabel(trend);

  // A MONTH WITH NOTHING POSTED IN IT IS THE THING TO SAY FIRST. Brightsphere
  // posts its whole year into one month and the other eleven rows are the
  // pack's measured-nil dash all the way across; a caption that instead named
  // a "biggest revenue month" there would be reporting a tie-break between
  // eleven nils. Where every month carries something, this clause is not
  // printed and the share sentence below is the caption.
  const posted = trend.filter((point) => point.revenue !== 0 || point.expenses !== 0);
  if (posted.length < trend.length) {
    const only = posted.length === 1 ? `${posted[0]!.label} alone carries` : `${posted.length} of them carry`;
    return `Nothing at all is posted in ${trend.length - posted.length} of the ${trend.length} months `
      + `shown: ${only} the whole of the postings over ${window}, which is why every other row is `
      + 'nil across every column.';
  }

  const total = trend.reduce((sum, point) => sum + point.revenue, 0);
  const biggest = trend.reduce((a, b) => (b.revenue > a.revenue ? b : a));
  // THE SHARE IS TAKEN OFF THE PRINTED FIGURES, not the raw ones — page 10's
  // lesson (`atScale`): a percentage computed on rands beside two figures
  // printed in thousands is a check the reader cannot reproduce, on a page
  // whose whole claim is that they can.
  const printed = (n: number) => Math.sign(n) * Math.round(Math.abs(n) / MONEY_SCALES[scale]);
  const base = printed(total);
  if (base <= 0) {
    return `Revenue over ${window} is ${money(total)}, which is not a positive base, so no `
      + `month's share of it is meaningful. The largest single month is ${biggest.label}, at `
      + `${money(biggest.revenue)}.`;
  }
  const share = (printed(biggest.revenue) / base) * 100;
  return `${biggest.label} carried the most revenue of any month, ${money(biggest.revenue)} of the `
    + `${money(total)} earned over ${window} — ${share.toFixed(1)}% of it.`;
}

/**
 * PAGE 5'S MEMORANDUM ON THE PACK'S ONE NON-IFRS MEASURE.
 *
 * EBITDA was a row of page 5's old results table, and it was the only row of
 * it that page 6 did not print again — so removing the duplication left this
 * one figure with nowhere to sit. It stays on page 5, in a sentence rather
 * than in the month-by-month table above it: every figure in that table is
 * ONE MONTH's and this one is the reporting period's, and a fourteenth row or
 * a sixth column would put two windows in one grid with nothing saying which
 * is which.
 *
 * Page 6 was measured for it first. With the EBITDA row added, the live
 * Brightsphere income statement composes at 252.4mm of a 255mm box with its
 * profit bridge already on the bottom rung of the height grid — room for the
 * row, none for the footnote that has to identify the measure beside it. A
 * non-IFRS measure is identified where it is PRESENTED, so the two travel
 * together or neither moves.
 *
 * The figures go through `inProse`, which says "nil" where `formatMoney`
 * prints the en dash a money column uses for a measured zero: a dash is not a
 * word in a sentence, and `checkProse` refuses a pack that puts one there.
 */
export function ebitdaMemoSentence(set: PackFigureSet, scale: MoneyScale): string {
  const current = inProse(formatMoney(ebitdaOf(set.current), { scale }));
  const comparative = set.prior === null
    ? 'There is no comparative period to state it against.'
    : `The comparative period's is ${inProse(formatMoney(ebitdaOf(set.prior), { scale }))}.`;
  return `EBITDA for the reporting period is ${current}. ${comparative} It is operating profit `
    + 'plus the depreciation and amortisation charged in the period, and it is presented because a '
    + 'board asks for it, not because a standard requires it. Every other figure on this sheet is '
    + 'one month\'s; this one is the reporting period\'s, which the footer of every sheet states. '
    + 'The basis of preparation reconciles it to operating profit line by line.';
}

/** The period's EBITDA, through the one service that owns the measure —
 *  `calculateExtendedRatios`, the same call page 12's reconciliation reads. */
function ebitdaOf(f: ReportPackFigures): number {
  return calculateExtendedRatios(toFinancialData(f)).ebitda;
}
