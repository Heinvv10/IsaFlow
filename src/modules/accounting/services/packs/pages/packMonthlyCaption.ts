/**
 * Page 5's sentences about its own table — the title, the caption, and the
 * largest figure on the wrong side of its band. Split out of
 * `packMonthlyResults.ts` for the 300-line cap; that file re-exports every
 * export here, so each caller still imports it there.
 */
import { formatStatementFigure, inProse, MONEY_SCALES, type MoneyScale } from '@/lib/format/money';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { monthLabel, wholeMonthsOf } from './packPartialMonth';
import { MEASURES, trendWindowLabel } from './packMonthlyMeasures';

/**
 * Page 5's title — a conclusion about the twelve months, not a label.
 *
 * It names the best and the worst month for net profit, which is the one
 * thing a month-by-month table says that a period statement cannot. Where
 * every month is the same figure there is no spread to name and the sentence
 * states the level instead, the same rule `movementSentence` follows.
 */
export function monthlyResultsTitle(series: PackTrendPoint[], scale: MoneyScale): string {
  // RANKED OVER WHOLE MONTHS. A two-day stub with a month's rent and no
  // revenue yet is not "the lowest month" — the comparison page 10 no longer
  // makes either (`wholeMonthsOf`). The table still prints it, marked.
  const trend = wholeMonthsOf(series);
  const whole = trend.length < series.length ? 'whole ' : '';
  // A DIGIT, because the title rule (`assertPageTitleIsAMessage`, a test-time
  // guard) fails a bare label — and the count is the fact anyway: none of the
  // months could be built.
  if (trend.length === 0) return 'No monthly series covers this period, so 0 months are shown.';
  const money = (n: number) => inProse(formatStatementFigure(n, { scale }));
  const best = trend.reduce((a, b) => (b.netProfit > a.netProfit ? b : a));
  const worst = trend.reduce((a, b) => (b.netProfit < a.netProfit ? b : a));
  const months = trend.length === 1 ? `the one ${whole}month` : `the ${trend.length} ${whole}months`;
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
  const money = (n: number) => inProse(formatStatementFigure(n, { scale }));
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
  // The total is the whole window's; the RANKING is over whole months, as the
  // title's is — a two-day stub is not "the most revenue of any month". Said
  // "whole" only where the stub out-earned them, which is the one case "any
  // month" would be false: the word costs page 5 a note on the live packs.
  const whole = wholeMonthsOf(trend);
  const biggest = (whole.length > 0 ? whole : trend).reduce((a, b) => (b.revenue > a.revenue ? b : a));
  const any = trend.some((p) => p.partial && p.revenue > biggest.revenue) ? 'any whole month' : 'any month';
  // THE SHARE IS TAKEN OFF THE PRINTED FIGURES, not the raw ones — page 10's
  // lesson (`atScale`): a percentage computed on rands beside two figures
  // printed in thousands is a check the reader cannot reproduce, on a page
  // whose whole claim is that they can.
  const printed = (n: number) => Math.sign(n) * Math.round(Math.abs(n) / MONEY_SCALES[scale]);
  const base = printed(total);
  if (base <= 0) {
    return `Revenue over ${window} is ${money(total)}, which is not a positive base, so no `
      + `month's share of it is meaningful. The largest single ${any === 'any whole month' ? 'whole month' : 'month'} is ${monthLabel(biggest)}, at `
      + `${money(biggest.revenue)}.`
      + largestContraryFigureSentence(trend, scale);
  }
  const share = (printed(biggest.revenue) / base) * 100;
  return `${monthLabel(biggest)} carried the most revenue of ${any}, ${money(biggest.revenue)} `
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
 * And it says nothing where NO figure carries the wrong sign for its band —
 * an unremarkable sheet needs no remark, and this pack does not manufacture
 * commentary.
 *
 * THE RANKING IS OVER THE CONTRARY FIGURES, NOT OVER ALL OF THEM. It used to
 * find the largest figure on the sheet and then fall silent unless that one
 * happened to be contrary, which is a different sentence from the one the
 * name and this docblock promise: a month with revenue of 10 000 and other
 * expenses of (9 000) has its maximum magnitude in the revenue — positive,
 * and in an income band — so the nine-million credit sitting in an expense
 * column was the exact disclosure this was written to make and the exact one
 * it withheld. Both live companies' largest figure IS their contrary one,
 * which is why the two readings agreed on everything measured.
 */
export function largestContraryFigureSentence(trend: PackTrendPoint[], scale: MoneyScale): string {
  let biggest: { point: PackTrendPoint; measure: (typeof MEASURES)[number]; value: number } | null = null;
  for (const point of trend) {
    for (const measure of MEASURES) {
      const value = measure.read(point);
      // The closing row is the sum of the months above it, so its totals are
      // not ranked; a result band is an ordinary loss the page's own title
      // already names.
      if (measure.band === 'result' || value >= 0) continue;
      if (biggest === null || Math.abs(value) > Math.abs(biggest.value)) biggest = { point, measure, value };
    }
  }
  if (biggest === null) return '';
  const money = (n: number) => inProse(formatStatementFigure(n, { scale }));
  return ` Of the months above, the largest figure on the wrong side of its band is `
    + `${monthLabel(biggest.point)}'s ${biggest.measure.prose} of ${money(biggest.value)}: more `
    + 'was reversed out of those accounts than was posted into them.';
}
