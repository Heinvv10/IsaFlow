/**
 * The reciprocal window footnotes — the pointer a statement page carries back
 * to the trends page, and the cash page's note on its own two windows. Moved
 * out of `packTrendCrossReference.ts` unchanged to keep that file under the
 * 300-line cap; `packTrendCrossReference.ts` re-exports both, and its header
 * states why the wording is "need not agree".
 */
import type { PackChartSpec, PackFootnote } from './packPageModel';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { PERIOD_COUNTERPARTS } from './packPeriodCounterparts';

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
