/**
 * THE PACK PRINTS THE SAME MEASURE OVER TWO DIFFERENT WINDOWS, AND BOTH ARE
 * RIGHT. This is where it says so — once on the trends page, and once on each
 * page that carries the period figure of a panel actually drawn.
 *
 * A page-10 panel plots one MONTH at a time and states its movement from the
 * first month of the series to the last. A statement page states the figure
 * for the WHOLE reporting period, measured against the comparative period.
 * The two answer different questions, so they do not agree, and on the live
 * demo pack they disagreed loudly:
 *
 *   - gross margin `(1348.0%)` for the period against `100.0%` for the last
 *     month;
 *   - debtor days `213` on the highlights and scorecard pages against `63.7`
 *     on the trends page;
 *   - "Revenue is up 1281.4% across 12 periods" against "Revenue has no
 *     positive comparative base for a percentage change".
 *
 * The first round of this fix wrote ONE note, about gross margin, pushed onto
 * the trends page unconditionally — which then printed on a pack that draws
 * no gross-margin panel at all (every month's revenue was nil), so the sheet
 * named a chart two centimetres above a disclosure explaining why that chart
 * is missing. Both halves of that are fixed here: the note is DERIVED from
 * the panels the page actually draws, so it can never name one that is not
 * there, and it covers every measure rather than the one that was noticed.
 *
 * THE WINDOW WAS ONCE A TRUE CAUSE STATED AS THE ONLY CAUSE, and that is
 * worth recording because eight blind gates read this note and passed it.
 * `getPackTrend` summed every `account_type = 'revenue'` account with no band
 * while `aggregateFigures` bands other income out of revenue, so the trends
 * page and the statements were reporting DIFFERENT MEASURES as well as
 * different windows — Brightsphere's revenue printed (5 536) here and (5 535)
 * on the income statement, the other-income account to the rand. The service
 * bands through `revenueBand` now (see `PackTrendPoint`), so the sentence
 * below is true of revenue, gross margin, operating expenses, net profit and
 * cash: one measure, two windows.
 *
 * DEBTOR DAYS IS THE ONE THAT IS STILL NOT ONLY THE WINDOW. The trends page
 * multiplies each month's ratio by the days in THAT month; the period figure
 * annualises on 365. Page 12's glossary has always defined both, and the note
 * names the difference rather than restating the definition — a second
 * paragraph here is paid for out of this page's own disclosures.
 *
 * PAGES ARE NAMED IN WORDS, never by number — page numbers come from position
 * in the sequence now, and a literal here is the class of cross-reference
 * that once sent a reader to the scorecard for the basis of preparation.
 */
import type { PackChartSpec, PackDisclosureNote, PackFootnote } from './packPageModel';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

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
interface PeriodCounterpart {
  /** How the measure is named on both pages. */
  measure: string;
  /** Which page carries the period figure, in the words the contents entry
   *  for that page uses. */
  page: string;
}

export const PERIOD_COUNTERPARTS: Record<string, PeriodCounterpart> = {
  'trend-revenue': { measure: 'revenue', page: 'income statement page' },
  'trend-gross-margin': { measure: 'gross margin', page: 'income statement page' },
  'trend-operating-expenses': { measure: 'operating expenses', page: 'income statement page' },
  'trend-net-profit': { measure: 'net profit', page: 'group results page' },
  'trend-cash': { measure: 'cash', page: 'cash page' },
  'trend-debtor-days': { measure: 'debtor days', page: 'scorecard page' },
};

/** "a, b and c". */
function inWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The drawn panels that have a period counterpart, grouped by the page that
 *  carries it, in the order the panels are drawn. */
function counterpartsByPage(panels: PackChartSpec[]): Array<{ page: string; measures: string[] }> {
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

/**
 * The trends page's own note: which of the measures on this page ALSO print
 * as a period figure, where, and why the two will not agree.
 *
 * Null when no drawn panel has a counterpart — a page with nothing to
 * reconcile must not carry a paragraph reconciling it.
 */
export function trendWindowNote(
  panels: PackChartSpec[],
  /** Ratio panels ending on the part month, by name — see
   *  `TrendPanels.ratiosEndingOnPartMonth`. Empty on a series that ends on a
   *  whole month, and on a pack that draws no ratio panel. */
  ratiosEndingOnPartMonth: readonly string[] = [],
): PackDisclosureNote | null {
  const groups = counterpartsByPage(panels);
  if (groups.length === 0) return null;

  const where = groups.map((g) => `${inWords(g.measures)} on the ${g.page}`);
  // Debtor days is measured differently as well as over a different window,
  // and a note that named only the window would be doing to that measure what
  // this whole file used to do to revenue.
  // ONE CLAUSE, and the length is the whole of the design. The first draft ran
  // two sentences and cost this page 8mm it did not have: `fitPageToBox` paid
  // for them by dropping THIS NOTE, so the sheet lost the reconciliation
  // entirely in order to make it more complete. The basis of preparation
  // already defines both annualisations in full; what is owed here is that
  // there is a second difference, not what it is.
  const debtorDays = panels.some((panel) => panel.id === 'trend-debtor-days')
    ? ' Debtor days also differs in its annualisation, which the basis of preparation defines.'
    : '';
  // THE FRAME IS SHORTER BY A LINE AND THE LIST IS UNTOUCHED. It read "plots
  // one MONTH at a time … — <list> — against the comparative period", and on
  // the live demo company, where all six panels have a counterpart, that ran
  // to five lines on a sheet 7.4mm past its paper. "at a time" says nothing
  // the sentence does not, and the comparative is a period by construction —
  // the basis page names its dates. Every measure and every page it points a
  // reader at is still here, in the same words.
  // A PART MONTH IS A DIFFERENT WINDOW TOO, AND FOR A RATIO IT IS A DIFFERENT
  // MEASUREMENT. The marker on the axis and in the panel title says WHICH
  // month; it does not say that a ratio taken over seven of thirty days is an
  // artefact of that window. Page 10 ended two panels on one — a 100.0% gross
  // margin (seven days of revenue, no cost of sales posted yet) and 60 debtor
  // days (a seven-day ratio annualised over a month) — and a director reads
  // the first as a turnaround. Named panels, so the clause cannot claim it of
  // a panel that ends on a whole month, and carried HERE because this note is
  // already the page's statement about windows: a disclosure of its own is
  // 6.5mm on a sheet that composes within 12 of its box.
  //
  // ONE CLAUSE, AND THE LENGTH IS AGAIN THE WHOLE OF THE DESIGN — the same
  // lesson the `debtorDays` clause above records. The first wording named the
  // panels ("Gross margin and Debtor days end on the part month: a ratio
  // there is computed on the days posted, so its level is not comparable with
  // the months before it") and ran to two lines, and `fitPageToBox` paid for
  // them by dropping THIS ENTIRE NOTE from the live demo pack — so the sheet
  // lost the whole month-versus-period reconciliation in order to qualify two
  // ratios. The panels are not named because they do not need to be: each one
  // already carries "(part)" in its own title and on its own last tick, which
  // is where a reader meets the ratio. What was missing is what the marker
  // MEANS for a ratio, and that is what this says.
  const partRatios = ratiosEndingOnPartMonth.length === 0
    ? ''
    : ' A ratio ending in the part month is taken on the days posted, not a full one.';
  return {
    heading: 'Period',
    body:
      'Each panel plots one MONTH. The same measures print for the WHOLE reporting period, '
      + `against the comparative — ${inWords(where)}. Different windows: the two `
      + `will not agree.${debtorDays}${partRatios}`,
  };
}

/**
 * The reciprocal pointer, for a page that carries the period figure — as a
 * page FOOTNOTE rather than a disclosure block.
 *
 * A director who reads the trends page first and turns back gets nothing from
 * a note that lives only on the trends page, which is what the rendered pack
 * did. But the two pages that need it are the two fullest in the pack: as a
 * headed disclosure it put the income statement 4.8mm and the scorecard
 * 12.2mm past the paper on the dense fixture, and a thirteenth sheet is not
 * an acceptable price for a cross-reference. The statement pages already
 * carry unreferenced footnotes of exactly this kind ("The prior column is the
 * period …"), so this is the shape the pack already uses for a fact about how
 * to read the page.
 *
 * Empty where the panel is not DRAWN, for the same reason as `trendWindowNote`
 * — a page must not point at a chart the pack does not contain.
 *
 * IT NAMES THE PAGE IT IS ABOUT. The note used to open "Debtor days on this
 * page is the figure for the whole reporting period" — and a render put it
 * alone on a blank thirteenth sheet, where "this page" pointed at nothing.
 * The composer now holds every page to its box so that cannot recur, but a
 * sentence whose truth depends on where it lands is the defect class this
 * whole page has been chasing: a reader who meets it out of context, in a
 * forwarded extract or a screen reader's linear order, can still tell which
 * page it means.
 *
 * @param pageName The page's own `navLabel` — the string the Contents prints,
 *   not a second spelling of it.
 * @param number The footnote number to issue, since the PAGE owns its own
 *   footnote numbering (see `PackKpiTile.trendFootnote`).
 */
export function periodWindowFootnotes(
  panels: PackChartSpec[],
  panelId: string,
  pageName: string,
  number: number,
): PackFootnote[] {
  const counterpart = PERIOD_COUNTERPARTS[panelId];
  if (counterpart === undefined) return [];
  if (!panels.some((panel) => panel.id === panelId)) return [];

  const measure = `${counterpart.measure.charAt(0).toUpperCase()}${counterpart.measure.slice(1)}`;
  return [{
    number,
    text:
      `${measure} on this page — the ${pageName.toLowerCase()} page — is the figure for the WHOLE `
      + 'reporting period, measured on the period totals; the trends page plots the same measure '
      + 'one month at a time. Different windows: the two will not agree.',
  }];
}

/**
 * THE CASH PAGE CARRIES BOTH WINDOWS, AND SAID NOTHING ABOUT IT.
 *
 * The table's Opening cash is the balance at the START OF THE REPORTING
 * PERIOD — (125) at 1 January on the live demo pack. The closing-cash line
 * directly beneath it plots the twelve months to the period end, so it opens
 * wherever that window does — (115) at the previous October. Two figures for
 * the word "opening", both labelled cash, on one sheet, with nothing
 * reconciling them; a reader adding them gets an error of ten.
 *
 * The income statement and the scorecard already carry exactly this note for
 * their own whole-period-against-monthly mismatch (`periodWindowFootnotes`),
 * and this is the same fact about the same pair of windows — it is the page
 * that carries BOTH of them that was missing it.
 *
 * Empty where no line is drawn: a page with one window has nothing to
 * reconcile.
 */
export function cashWindowFootnotes(
  trend: PackTrendPoint[],
  cashTrendDrawn: boolean,
  number: number,
): PackFootnote[] {
  const first = trend[0];
  if (!cashTrendDrawn || first === undefined) return [];
  return [{
    number,
    text:
      'Opening cash in the table above is the balance at the START of the reporting period. The '
      + `closing-cash line below it plots ${trend.length} months to the period end and opens at `
      + `${first.label}, so it starts from the balance at that month instead. Different windows: `
      + 'the two will not agree.',
  }];
}
