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
import { monthLabel } from './packPartialMonth';
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

/**
 * THE BAND A MEASURE SITS IN, which is what decides whether its sign is
 * ordinary or the thing to say out loud.
 *
 * An income column is a credit band and an expense column a debit band, so a
 * NEGATIVE figure in either is contrary to the band: more was reversed out of
 * those accounts than posted into them. `netProfit` is neither — a loss is an
 * ordinary result, not an anomaly — and carries no reading.
 */
type MeasureBand = 'income' | 'expense' | 'result';

const MEASURES: ReadonlyArray<{
  column: PackTableColumnKey;
  field: string;
  read: (p: PackTrendPoint) => number;
  band: MeasureBand;
  /** The measure's name in a SENTENCE. Two of the column headings are
   *  abbreviated because `TABLE_HEAD_MM` budgets one line for a 7pt caps
   *  heading over a 26mm measure ("Operating", "Other"), and a caption that
   *  used those would name half a measure. The page's own "The columns" note
   *  glosses both, so a reader given the full name finds the column. */
  prose: string;
}> = [
  { column: 'revenue', field: 'revenue', read: (p) => p.revenue, band: 'income', prose: 'revenue' },
  { column: 'otherIncome', field: 'otherIncome', read: (p) => p.otherIncome, band: 'income', prose: 'other income' },
  { column: 'costOfSales', field: 'costOfSales', read: (p) => p.costOfSales, band: 'expense', prose: 'cost of sales' },
  { column: 'monthOperatingExpenses', field: 'operatingExpenses', read: (p) => p.operatingExpenses, band: 'expense', prose: 'operating expenses' },
  { column: 'otherExpenses', field: 'otherExpenses', read: otherExpensesOf, band: 'expense', prose: 'other expenses' },
  { column: 'netProfit', field: 'netProfit', read: (p) => p.netProfit, band: 'result', prose: 'net profit' },
];

/** What the closing row is called — its own window, never "Total". See the
 *  header: the pack's period is a different window and prints its own totals
 *  on the next sheet. */
export function trendWindowLabel(trend: PackTrendPoint[]): string {
  const last = trend[trend.length - 1]!;
  const months = trend.length === 1 ? '1 month' : `${trend.length} months`;
  // THE STUB IS MARKED IN THE TOTAL ROW'S OWN LABEL, because the total row is
  // where a reader who never reaches the last month meets the window: it sums
  // eleven whole months and seven days of a twelfth, and "12 months to Sep
  // 2026" says otherwise. See `packPartialMonth.ts`.
  return `${months} to ${monthLabel(last)}`;
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
  // LOWEST AND HIGHEST, NAMED AS SUCH — NOT "runs from … to …".
  //
  // This sentence and page 10's panel titles are the same "from X to Y over N
  // periods" construction over the same measure and the same window, and they
  // mean different things: this one is the MIN and the MAX, the panel's is the
  // FIRST and the LAST. The rendered pack printed "Net profit runs from (784)
  // in Jan 2026 to 1 908 in Jul 2026 across the 12 months" three sheets from
  // "Net profit rose from (99) to (11) over 12 periods", and a reader has no
  // way to know which sentence is which — worse, "runs from … in Jan 2026"
  // reads as a chronology on a table whose first row is Oct 2025.
  //
  // So this one names what it measures. "lowest at … and highest at …" cannot
  // be read as a start and an end, and `movementSentence` keeps the panels'
  // wording unchanged — two constructions, visibly different, rather than one
  // construction carrying two meanings.
  const side = (point: PackTrendPoint, count: number) => (count === 1
    ? `${money(point.netProfit)} in ${monthLabel(point)}`
    : `${money(point.netProfit)} in ${count} of ${months}`);
  return `Net profit is lowest at ${side(worst, worstAt)} and highest at ${side(best, bestAt)}`
    + `${bestAt === 1 && worstAt === 1 ? ` across ${months}` : ''}.`;
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
    // AND IT GIVES UP ITS LAST CLAUSE, which read "which is why every other
    // row is nil across every column" — a restatement of "nothing at all is
    // posted in 11 of the 12 months shown" at the other end of the same
    // sentence. Brightsphere's page 5 composes with 3.42mm of slack and a
    // line of this narrative costs 5.29, so the largest-figure sentence had
    // to be paid for; a restatement is what goes.
    return `Nothing at all is posted in ${trend.length - posted.length} of the ${trend.length} months `
      + `shown: ${only} the whole of the postings over ${window}.`
      + largestContraryFigureSentence(trend, scale);
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
      + `month's share of it is meaningful. The largest single month is ${monthLabel(biggest)}, at `
      + `${money(biggest.revenue)}.`
      + largestContraryFigureSentence(trend, scale);
  }
  const share = (printed(biggest.revenue) / base) * 100;
  return `${monthLabel(biggest)} carried the most revenue of any month, ${money(biggest.revenue)} `
    + `of the ${money(total)} earned over ${window} — ${share.toFixed(1)}% of it.`
    + largestContraryFigureSentence(trend, scale);
}

/**
 * THE BIGGEST NUMBER ON THE SHEET, WHERE ITS SIGN IS THE THING TO SAY.
 *
 * The demo pack's largest figure is a COST OF SALES OF (1 922) — a cost line
 * that is a net credit, and the single most arresting thing on the page — and
 * page 5 said nothing about it: its title names net profit and its caption
 * spent itself on July's 36.6% share of revenue. Brightsphere is the same
 * shape with the sign the other way round: (5 535) of revenue in April. A
 * director who reads only the group-results page sees a profitable July and
 * is given no reason for it. The explanation was real and it was two sheets
 * away, on pages 4 and 11.
 *
 * It is stated IN PLACE rather than pointed at, because the reading is
 * derivable from the figure itself: a negative in a credit band, or in a
 * debit band, is more reversed out of those accounts than posted into them —
 * the same inference `creditMonthMatters` prints on page 11, in the same
 * words, so the two sheets cannot come to say it differently.
 *
 * THREE THINGS IT DELIBERATELY DOES NOT DO.
 *
 * It does not rank the CLOSING row's totals. That row is the sum of the
 * months above it, so a total that is the sheet's largest figure is a column
 * of ordinary months added up, and naming it points at nothing; the sentence
 * says "among the months above" rather than "on this sheet" so that the claim
 * is the one it actually checked. It also removes a tie: Brightsphere posts
 * one month, so its April revenue and its window revenue are the same figure.
 *
 * It says nothing where the largest figure is a NET PROFIT. A loss is an
 * ordinary result and the page's own title already names the highest and the
 * lowest month for it.
 *
 * And it says nothing where the largest figure carries its band's ordinary
 * sign — an unremarkable biggest number needs no remark, and this pack does
 * not manufacture commentary.
 */
export function largestContraryFigureSentence(trend: PackTrendPoint[], scale: MoneyScale): string {
  let biggest: { point: PackTrendPoint; measure: (typeof MEASURES)[number]; value: number } | null = null;
  for (const point of trend) {
    for (const measure of MEASURES) {
      const value = measure.read(point);
      if (biggest === null || Math.abs(value) > Math.abs(biggest.value)) biggest = { point, measure, value };
    }
  }
  if (biggest === null || biggest.measure.band === 'result' || biggest.value >= 0) return '';
  const money = (n: number) => inProse(formatMoney(n, { scale }));
  return ` The largest figure among the months above is ${monthLabel(biggest.point)}'s `
    + `${biggest.measure.prose} of ${money(biggest.value)}: more was reversed out of those `
    + 'accounts than was posted into them.';
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
export function ebitdaMemoSentence(
  set: PackFigureSet,
  scale: MoneyScale,
  /**
   * The label the table's closing row prints — `trendWindowLabel`, passed
   * rather than re-derived so the sentence names the row a reader can see.
   *
   * NULL where the sheet draws no table (`trend.length === 0`), and the
   * windows clause is then dropped entire: with no monthly figures on the
   * paper there is no other window to distinguish this one from, and a
   * sentence contrasting it with rows that are not there is the same defect
   * in the other direction.
   */
  windowLabel: string | null,
): string {
  const current = inProse(formatMoney(ebitdaOf(set.current), { scale }));
  const comparative = set.prior === null
    ? 'There is no comparative period to state it against.'
    : `The comparative period's is ${inProse(formatMoney(ebitdaOf(set.prior), { scale }))}.`;
  // AND IT NO LONGER POINTS AT THE FOOTER. "which the footer of every sheet
  // states" is a description of the sheet's own furniture — the running
  // footer carries the period on all twelve pages — and it cost this note a
  // line of 9.5pt on both companies. That line is what pays for the
  // largest-figure sentence in the caption below. The fact it restated is
  // still on every sheet; what went was the sentence saying so.
  return `EBITDA for the reporting period is ${current}. ${comparative} It is operating profit `
    + 'plus the depreciation and amortisation charged in the period, and it is presented because a '
    + 'board asks for it, not because a standard requires it. '
    // THREE WINDOWS ON THIS SHEET, AND THE SENTENCE USED TO CLAIM TWO. It
    // read "Every other figure on this sheet is one month's", and the table's
    // closing row — headed with the window label, directly above this note —
    // is the twelve months to the period end, which the derived commentary
    // below then says in as many words ("over 12 months to Sep 2026 (part)").
    // A reader was told the total row was a month's figure by the one
    // paragraph on the sheet whose whole job is to say which window a figure
    // belongs to. The window is NAMED rather than called "the total row"
    // because the label is what the row prints.
    //
    // IT IS PAID FOR, NOT ADDED. This note wraps with 27 characters to spare
    // on both live companies, and page 5 composes at 251.93mm of 255 — a
    // second line costs 4.94mm the sheet does not have, and the note is
    // `required`, so `fitPageToBox` cannot pay for it by dropping this and
    // would take the sheet past its box instead. "Every figure above covers a
    // month or <label>; this one covers the reporting period." is 108
    // characters against the 84 it replaces, measured on the composed page:
    // p5 stays at 251.93mm on both companies, and at 110 characters it does
    // not.
    + (windowLabel === null
      ? ''
      : `Every figure above covers a month or the ${windowLabel}; this one covers the reporting `
        + 'period. ')
    // BOTH COLUMNS, now that page 12 bridges both. This sentence stated the
    // comparative EBITDA with the same prominence as the current one and then
    // pointed at a reconciliation that covered only the current — so the
    // figure a reader was most likely to query was the one with no bridge.
    + `The basis of preparation reconciles ${set.prior === null ? 'it' : 'both'} to operating `
    + 'profit line by line.';
}

/** The period's EBITDA, through the one service that owns the measure —
 *  `calculateExtendedRatios`, the same call page 12's reconciliation reads. */
function ebitdaOf(f: ReportPackFigures): number {
  return calculateExtendedRatios(toFinancialData(f)).ebitda;
}
