/**
 * Which page carries the whole-period figure of each page-10 panel, and how
 * that figure is arrived at there. Moved out of `packTrendCrossReference.ts`
 * unchanged to keep that file under the 300-line cap;
 * `packTrendCrossReference.ts` re-exports `PERIOD_COUNTERPARTS`.
 */
import type { PackChartSpec } from './packPageModel';

/**
 * A drawn panel, and where in the pack the same measure prints for the whole
 * period.
 *
 * Keyed by the panel id `packTrendCharts` issues, so a panel that stops being
 * drawn stops being named — that is the whole mechanism. A panel with no
 * entry here contributes nothing, which is the safe direction: a note that
 * names too few measures is thin, a note that names one the pack does not
 * print is false.
 */
export interface PeriodCounterpart {
  /** How the measure is named on both pages. */
  measure: string;
  /**
   * WHETHER THE PAGE PRINTS THIS MEASURE AGAINST THE COMPARATIVE — which is
   * a different question from whether it prints it at all, and the trends
   * page's own note was asserting the first while checking the second.
   *
   * The note reads "The same measures print for the WHOLE reporting period,
   * AGAINST THE COMPARATIVE — revenue, gross margin, operating expenses and
   * net profit on the income statement page …". Five of those six satisfy
   * it. Gross margin does not: page 6 carries a prior column, but gross
   * margin is not one of the rows in it — the page prints the measure ONLY in
   * the `% OF REVENUE` column, which has no comparative for any row. Revenue,
   * operating expenses and net profit are rows with actual AND prior; gross
   * margin is a percentage of one column of one period.
   *
   * Naming page 9 instead was measured and is worse: the scorecard's gross
   * margin prior is null on the live demo company, so the pointer would
   * resolve to an empty cell. The measure is dropped from THIS list and keeps
   * its reciprocal footnote on page 6 (`periodWindowFootnotes`), which claims
   * only that the page prints the whole-period figure — true, in the
   * `% of revenue` column.
   *
   * Stated per entry rather than defaulted, for the reason
   * `wholePeriodBasis` is: the one measure it is false of is the one nobody
   * checks.
   */
  printsAgainstComparative: boolean;
  /** Which page carries the period figure, in the words the contents entry
   *  for that page uses. */
  page: string;
  /**
   * HOW THE PERIOD FIGURE IS ARRIVED AT, on the page that prints it.
   *
   * Required on every entry rather than defaulted, because a measure whose
   * basis is not "the period totals" is the one where the reader is most
   * likely to be misled, and a default is what an author forgets. Debtor days
   * WAS one: annualised on 365, 59 over 101 printed 213 days over a reporting
   * period of 250, where the period's own day count gives 146 — and a
   * director read 213 against a 30-day target. The engine multiplies by the
   * period's own days now, so its entry says that instead.
   *
   * The clause is spent out of the sentence it replaces, not added to it:
   * page 9 composes at 253.29mm in a 255mm box, so a second line of footnote
   * costs 3.88mm the sheet does not have and `fitPageToBox` answers by
   * dropping the whole note. "over the period's own days" is shorter than
   * the 365 clause it replaced, so the page does not move.
   */
  wholePeriodBasis: string;
}

/** What every measure but one is: a total over the reporting window. */
const ON_THE_PERIOD_TOTALS = 'measured on the period totals';

export const PERIOD_COUNTERPARTS: Record<string, PeriodCounterpart> = {
  'trend-revenue': { measure: 'revenue', printsAgainstComparative: true, page: 'income statement page', wholePeriodBasis: ON_THE_PERIOD_TOTALS },
  'trend-gross-margin': { measure: 'gross margin', printsAgainstComparative: false, page: 'income statement page', wholePeriodBasis: ON_THE_PERIOD_TOTALS },
  'trend-operating-expenses': { measure: 'operating expenses', printsAgainstComparative: true, page: 'income statement page', wholePeriodBasis: ON_THE_PERIOD_TOTALS },
  // THE INCOME STATEMENT, NOT THE MONTHLY RESULTS PAGE. The monthly results page
  // prints net profit BY MONTH and a total over the trend window; it carries
  // no reporting-period figure and no comparative column, so a director who
  // followed this pointer found the twelve-month total — (1 901) on the live
  // demo pack — where the sentence promised the period's (1 544) against a
  // comparative of (905). A plausible wrong number is worse than none, and
  // this was the one wrong destination in a sentence whose other five
  // pointers were right. It is invisible on a company whose activity sits in
  // one month, where the two windows coincide, which is why the test that
  // holds it uses the demo shape.
  'trend-net-profit': { measure: 'net profit', printsAgainstComparative: true, page: 'income statement page', wholePeriodBasis: ON_THE_PERIOD_TOTALS },
  'trend-cash': { measure: 'cash', printsAgainstComparative: true, page: 'cash page', wholePeriodBasis: ON_THE_PERIOD_TOTALS },
  'trend-debtor-days': {
    measure: 'debtor days',
    printsAgainstComparative: true,
    page: 'scorecard page',
    // Its own days, as the trends page's months are theirs: the window is
    // the only difference between the two, and the note says so. Shorter
    // than the 365 clause it replaces, on a sheet that has no slack.
    wholePeriodBasis: 'over the period\'s own days',
  },
};

/** The drawn panels that have a period counterpart, grouped by the page that
 *  carries it, in the order the panels are drawn. */
export function counterpartsByPage(panels: PackChartSpec[]): Array<{ page: string; measures: string[] }> {
  const byPage: Array<{ page: string; measures: string[] }> = [];
  for (const panel of panels) {
    const counterpart = PERIOD_COUNTERPARTS[panel.id];
    if (counterpart === undefined) continue;

    const group = byPage.find((g) => g.page === counterpart.page);
    if (group) group.measures.push(counterpart.measure);
    else byPage.push({ page: counterpart.page, measures: [counterpart.measure] });
  }
  return byPage;
}
