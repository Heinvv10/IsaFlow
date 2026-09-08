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
 *
 * "NEED NOT AGREE", NOT "WILL NOT AGREE", AND THE ONE WORD WAS FALSE ON THREE
 * SHEETS AT ONCE. Every one of the three sentences below asserted that a
 * month figure and a period figure CANNOT match, and each was printed above a
 * pair that did:
 *
 *   - Brightsphere's cash page carried "Opening cash (267)" in its table and
 *     "Closing cash fell from (267) at Oct 2025" in the chart caption twelve
 *     lines under it, with `cashWindowFootnotes` between them saying the two
 *     would not agree;
 *   - Brightsphere's trends page asserted it of FOUR measures that equal
 *     their period figures exactly — revenue (5 535), operating expenses
 *     (3 717), net profit (1 408) and closing cash (3 453) — because the
 *     company posts its whole year into one month, so that month IS the
 *     period;
 *   - the demo pack asserted it of closing cash, where agreement is
 *     structurally guaranteed: cash is a STOCK, so the last point of a
 *     12-month series and the period's closing balance are the same balance
 *     on the same date whatever the two windows are.
 *
 * The third is the one that decides the word. The first two are companies a
 * different ledger would not produce; the third is arithmetic, and no pack
 * can ever print those two figures differently. A universal claim with a
 * structural counter-example is not a strong statement of a true idea, it is
 * a false sentence — and a footnote telling a director that two numbers
 * cannot match, set above two matching numbers, is what a preparer gets asked
 * to explain in the room.
 *
 * The idea itself survives intact, which is why the fix is a word and not a
 * deletion: a month and a reporting period ARE different windows, a reader
 * comparing them across sheets does need telling, and "need not agree" says
 * exactly that without claiming the arithmetic forbids it. It is also
 * character-for-character with what it replaces, which this file cares about
 * — `trendWindowNote` has zero characters of slack on the live demo sheet
 * (252.47mm of 255), and three more take the page to another line, at which
 * point `fitPageToBox` answers by dropping the whole note.
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
   * Required on every entry rather than defaulted, because the one measure
   * where it is not "the period totals" is the one where the reader is most
   * likely to be misled, and a default is what an author forgets. Debtor days
   * is ANNUALISED: 59 over 101 times 365 is the 213 the scorecard prints,
   * over a reporting period of 250 days — on the period's own day count the
   * same book is 146 days. A director reads 213 against a 30-day target and
   * a third of that gap is the multiplier, which page 12 discloses and page 9
   * did not.
   *
   * The clause is spent out of the sentence it replaces, not added to it:
   * page 9 composes at 253.29mm in a 255mm box, so a second line of footnote
   * costs 3.88mm the sheet does not have and `fitPageToBox` answers by
   * dropping the whole note. "annualised on 365 days whatever the period's
   * own length" is shorter than "measured on the period totals" plus the
   * 30 characters of slack the wrapped pair had left, and the page does not
   * move.
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
    // "whatever the period's length", not "whatever the period's OWN length",
    // and "a month at a time" rather than "one month at a time" in the frame
    // below: six characters, which is what carries the base caveat onto the
    // row that prints a red MISS without this note taking a third line.
    wholePeriodBasis: 'annualised on 365 days whatever its length',
  },
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
 * as a period figure, where, and why the two need not agree.
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
  /**
   * Whether the page this panel points at PRINTS a comparative figure for it,
   * read off the composed page rather than assumed — see `without` below.
   * Defaults to true so a caller that cannot say does not silently turn every
   * measure into an exception.
   */
  printsComparative: (panelId: string) => boolean = () => true,
): PackDisclosureNote | null {
  const groups = counterpartsByPage(panels);
  if (groups.length === 0) return null;

  const where = groups.map((g) => `${inWords(g.measures)} on the ${g.page}`);
  // EVERY PANEL ON THE SHEET IS ACCOUNTED FOR, AND THE EXCEPTION IS NAMED
  // RATHER THAN OMITTED.
  //
  // The round before this one DROPPED gross margin from the list, because
  // the sentence claimed "against the comparative" and page 6 prints that
  // measure only in the actual `% OF REVENUE` column. That traded a wrong
  // pointer for an incomplete enumeration: the demo's note then mapped 5 of
  // its own 6 panels while page 6's footnote 4 said from the other end that
  // the trends page plots the same measure monthly, and Brightsphere's
  // sentence listed all 4 of its 4 — true on one company and false on the
  // other, which is this branch's recurring defect wearing its sixth face.
  //
  // So the measure is back in the list and the comparative claim carries its
  // own exception. Naming page 9 instead was measured and is worse: the
  // scorecard's gross-margin prior is null on the live demo company, so the
  // pointer would resolve to an empty cell.
  //
  // THE WORDING IS THE SHORTEST THAT SAYS IT, and that is the whole of the
  // design. This note has between twenty and thirty-nine characters of wrap
  // on `liveDemoRendered`, whose page 10 composes at 252.47mm of 255, and at
  // forty `fitPageToBox` drops the note entire. Spelling out where gross
  // margin's comparative is not — "which the income statement prints for the
  // actual column alone" — is ninety.
  //
  // AND THE EXCEPTION SET IS DERIVED FROM THE CELLS, NOT DECLARED IN A TABLE.
  //
  // `printsAgainstComparative` is a STRUCTURAL fact — page 6 carries no
  // comparative column for gross margin at all — and it was the whole test.
  // That is only half of what "against the comparative" claims: the demo
  // pack's page 9 prints Debtor days PRIOR as `n/m`, the same state as gross
  // margin's, and page 10 named gross margin alone. A sentence listing one of
  // its two exceptions is disproved by the sheet it points at.
  //
  // `printsComparative` is the caller's reading of the composed page — the
  // cell a reader would actually turn to — so a measure whose prior is not
  // meaningful this period joins the list without anyone having to remember
  // to declare it. The structural flag stays as the other half: a measure
  // with no comparative COLUMN is an exception whatever the data says.
  const without = panels
    .map((panel) => ({ panel, counterpart: PERIOD_COUNTERPARTS[panel.id] }))
    .filter((x): x is { panel: PackChartSpec; counterpart: PeriodCounterpart } => x.counterpart !== undefined)
    .filter((x) => !x.counterpart.printsAgainstComparative || !printsComparative(x.panel.id))
    .map((x) => x.counterpart.measure);
  const comparative = without.length === 0
    ? ' against the comparative'
    // "BUT" READ AS A CONJUNCTION AND LEFT THE CLAUSE WITHOUT A VERB.
    // "…on the scorecard page — against the comparative but gross margin and
    // debtor days." parses as a sentence that stops mid-thought; the reading
    // meant was "except". Brightsphere's copy is complete only because it
    // needs no exception at all, which is how it survived a gate.
    : ` — against the comparative, except ${inWords(without)}`;
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
    // "the basis page", which is what every other pointer in the pack calls
    // sheet 12 — and ten of the sixteen characters the second comparative
    // exception costs this note.
    ? ' Debtor days also differs in its annualisation, which the basis page defines.'
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
  // AND IT QUALIFIES THE ENDPOINT RATHER THAN ONLY EXPLAINING THE METHOD.
  // It read "…is taken on the sums posted, not a full one", which states how
  // the number was made and leaves the reader to draw the conclusion. Page 10
  // is the only sheet in the pack that plots RATIOS ending in the stub, and
  // it was the only sheet not carrying the cover's "not comparable with the
  // months before it" — so "Debtor days rose from 19 days to 60 days"
  // presented a threefold rise whose last point rests on seven days of
  // revenue, tagged but never qualified. The clause now ends where every
  // other sheet's does, in the pack's own words (`partialMonthClause`), so
  // one wording covers the whole document.
  //
  // AND THE UNIT IS THE MONEY, NOT A DAY COUNT. It read "taken on the days
  // posted", which page 12 disproves in its own words: the trends page
  // "multiplies each month's ratio by the days in that month", and Sep's 60
  // debtor days is 59 over 30 times THIRTY, not times the seven days posted.
  // The clause was describing the numerator's window with the denominator's
  // multiplier and got a reader to the wrong arithmetic either way, so it
  // names the sums the ratio is taken on and makes no claim about days at
  // all. "sums" for "days" is character-for-character, which is the whole of
  // why it is that word: this note has ZERO characters of slack — three more
  // takes it to another line and `fitPageToBox` answers by dropping the note
  // entire, which is measured, not feared (252.47mm of 255 with the clause,
  // 236.04 with three characters added, the difference being the note).
  //
  // AND THE UNIT IS THE MONEY, NOT A DAY COUNT. It read "taken on the days
  // posted", which page 12 disproves in its own words: the trends page
  // "multiplies each month's ratio by the days in that month", and Sep's 60
  // debtor days is 59 over 30 times THIRTY, not times the seven days posted.
  // The clause was describing the numerator's window with the denominator's
  // multiplier and got a reader to the wrong arithmetic either way, so it
  // names the sums the ratio is taken on and makes no claim about days at
  // all. "sums" for "days" is character-for-character, which is the whole of
  // why it is that word: this note has ZERO characters of slack — three more
  // takes it to another line and `fitPageToBox` answers by dropping the note
  // entire, which is measured, not feared (252.47mm of 255 with the clause,
  // 236.04 with three characters added, the difference being the note).
  //
  // ONE CLAUSE, AND THE LENGTH IS AGAIN THE WHOLE OF THE DESIGN — the same
  // lesson the `debtorDays` clause above records. The first wording named the
  // panels ("Gross margin and Debtor days end on the part month: a ratio
  // there is computed on the sums posted, so its level is not comparable with
  // the months before it") and ran to two lines, and `fitPageToBox` paid for
  // them by dropping THIS ENTIRE NOTE from the live demo pack — so the sheet
  // lost the whole month-versus-period reconciliation in order to qualify two
  // ratios. The panels are not named because they do not need to be: each one
  // already carries "(part)" in its own title and on its own last tick, which
  // is where a reader meets the ratio. What was missing is what the marker
  // MEANS for a ratio, and that is what this says.
  const partRatios = ratiosEndingOnPartMonth.length === 0
    ? ''
    : ' A ratio ending in the part month is taken on the sums posted, so its level is not '
      + 'comparable with the months before it.';
  return {
    heading: 'Period',
    body:
      // "the WHOLE period", not "the WHOLE reporting period": the contrast in
      // this sentence is with a MONTH, which the clause before it states, and
      // the ten characters are what carry "except" in place of the "but" that
      // left the exception clause without a verb.
      'Each panel plots one MONTH. The same measures print for the WHOLE period — '
      + `${inWords(where)}${comparative}. Different windows: the two `
      + `need not agree.${debtorDays}${partRatios}`,
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
      // "ON THIS PAGE — THE SCORECARD PAGE —" NAMES THE SHEET IT IS PRINTED
      // ON, TWICE. A reader holding sheet 9 does not need to be told sheet 9
      // is sheet 9, and the room the twenty-two characters cost is room the
      // fullest pages in the pack do not have. `pageName` is still the
      // parameter the caller passes, because it is what the OTHER end of the
      // cross-reference is named by.
      //
      // THE BASE CAVEAT IS NOT APPENDED HERE. It used to be — this function
      // took an `extra` clause so page 9's red `Debtor days` row could carry
      // the disowned-base sentence inside this footnote — and
      // `packScorecardNotes` now builds that sheet's whole row note itself,
      // in wording shortened for the paper it has (`debtorWindow`). The
      // parameter outlived its caller by a round, documented at length,
      // deletable with the suite green.
      `${measure} on this page is the figure for the WHOLE `
      + `reporting period, ${counterpart.wholePeriodBasis}; the trends page plots the same measure `
      + 'a month at a time. Different windows: the two need not agree.',
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
      + 'the two need not agree.',
  }];
}
