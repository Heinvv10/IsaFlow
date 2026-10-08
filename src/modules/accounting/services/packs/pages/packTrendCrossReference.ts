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
 * DEBTOR DAYS IS NOW ONLY THE WINDOW TOO. The trends page multiplies each
 * month's ratio by the days in THAT month, and the period figure annualised
 * on 365 — so this note carried a clause saying the two also differed in
 * their annualisation. The engine multiplies by the period's own days now
 * (`FinancialData.periodDays`), one rule on both pages, and the clause is
 * gone: a difference the note names that the figures no longer have is a
 * false sentence on the sheet.
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
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type { PackChartSpec, PackDisclosureNote } from './packPageModel';
import { counterpartsByPage, PERIOD_COUNTERPARTS, type PeriodCounterpart } from './packPeriodCounterparts';

export { PERIOD_COUNTERPARTS } from './packPeriodCounterparts';
export { cashWindowFootnotes, periodWindowFootnotes } from './packWindowFootnotes';

/** "a, b and c". */
function inWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
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
  /** The part month no panel draws — see `TrendPanels.partMonthLeftOut`.
   *  Null on a series that ends on a whole month. */
  partMonthLeftOut: PackTrendPoint | null = null,
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
  const counterparts = panels
    .map((panel) => ({ panel, counterpart: PERIOD_COUNTERPARTS[panel.id] }))
    .filter((x): x is { panel: PackChartSpec; counterpart: PeriodCounterpart } => x.counterpart !== undefined);
  const without = counterparts
    .filter((x) => !x.counterpart.printsAgainstComparative || !printsComparative(x.panel.id))
    .map((x) => x.counterpart.measure);
  // AND WHERE NOTHING PRINTS ONE, THE CLAIM IS NOT MADE. A first-period pack
  // has no comparative column on any sheet, and "against the comparative,
  // except" followed by every measure on the page is a sentence about a
  // period the pack does not have.
  //
  // AND THE CLAUSE SITS ON THE PAGES IT IS TRUE OF. It trailed the list —
  // "…debtor days on the scorecard page — against the comparative, except…" —
  // and a reader took it for a statement about THIS sheet's panels, which
  // show no comparative. It is said of the other pages now, before they are
  // listed; the exception keeps its own verb ("except", not "but").
  const comparative = without.length === counterparts.length
    ? ''
    : without.length === 0
    ? ', with a comparative'
    : `, with a comparative except ${inWords(without)}`;
  // THE FRAME IS SHORTER BY A LINE AND THE LIST IS UNTOUCHED. It read "plots
  // one MONTH at a time … — <list> — against the comparative period", and on
  // the live demo company, where all six panels have a counterpart, that ran
  // to five lines on a sheet 7.4mm past its paper. "at a time" says nothing
  // the sentence does not, and the comparative is a period by construction —
  // the basis page names its dates. Every measure and every page it points a
  // reader at is still here, in the same words.
  //
  // WHICH MONTH IS NOT ON THE SHEET. The panels draw whole months only (see
  // `wholeMonthsOf`), so a pack run to 2 October ends them in September; a
  // reader who finds October on page 5 and not here is told why, in the
  // clause's shortest form — this note has little slack on the live demo.
  const leftOut = partMonthLeftOut === null
    ? ''
    : ` ${partMonthLeftOut.label} is a part month and is not drawn.`;
  return {
    heading: 'Period',
    body:
      // "the WHOLE period", not "the WHOLE reporting period": the contrast in
      // this sentence is with a MONTH, which the clause before it states. The
      // frame is character-for-character the length of the one it replaces —
      // this note has no slack on the live demo sheet.
      'Each panel plots one MONTH. The WHOLE period\'s figures print on other pages'
      + `${comparative} — ${inWords(where)}. Different windows: the two `
      + `need not agree.${leftOut}`,
  };
}
