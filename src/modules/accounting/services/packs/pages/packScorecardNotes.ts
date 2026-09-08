/**
 * PAGE 9'S TWO FOOTNOTES, AND THE ROW MARKERS THAT POINT AT THEM.
 *
 * Lifted out of `boardPackPages` whole. Three rounds of rulings landed here —
 * the disowned-base flag, the debtor-days window clause and the prior-column
 * note — and between them they were 75 lines of the composer about one sheet.
 * Nothing changed in the move.
 *
 * ONE NOTE FOR EVERY SCORED ROW THAT NEEDS ONE, AND THAT IS ARITHMETIC.
 * Carried as separate footnotes the sheet needs 256.11mm of a 255mm box.
 */
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { priorColumnFootnote } from './packBasis';
import { commentary, disclose, note } from './packPageBlocks';
import { page, type UnnumberedPage } from './packFrontMatter';
import { scorecardCaption, scorecardTitle } from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { disownedBases, disownedBasesFootnoteText } from './packDisownedBases';
import type { ImpossibleBalanceLine } from './packPageBlocks';
import { PERIOD_COUNTERPARTS, periodWindowFootnotes } from './packTrendCrossReference';
import type {
  PackChartSpec,
  PackComparativePeriod,
  PackFootnote,
  PackScorecardGroup,
} from './packPageModel';

export interface ScorecardPageNotes {
  /** The single row-marker footnote, or none where no row needs one. */
  rowNote: PackFootnote[];
  /** The prior-column note pages 6, 7 and 8 also carry, or null. */
  scorecardPriorNote: PackFootnote | null;
  /** The scorecard with footnote 1 attached to every row that earns it. */
  scoredOnDisowned: PackScorecardGroup[];
}

export function scorecardPageNotes(input: {
  scorecard: PackScorecardGroup[];
  set: PackFigureSet;
  panels: PackChartSpec[];
  comparativePeriod: PackComparativePeriod | null;
  /** True where page 4's debtors-base note fires — asked of that builder. */
  debtorsBaseApplies: boolean;
  /** The lines page 7's "Balances below zero" block names. */
  page7Impossible: readonly ImpossibleBalanceLine[];
}): ScorecardPageNotes {
  const { scorecard, set, panels, comparativePeriod, debtorsBaseApplies, page7Impossible } = input;
// Only whether the panel is DRAWN — the sentence itself is built below,
// shorter, for a sheet with 1.11mm of paper. The gate this preserves is
// that the note fires only where the trends page actually plots the
// measure it points at.
const debtorDaysFootnote = periodWindowFootnotes(panels, 'trend-debtor-days', 'Scorecard', 1);
// AND PAGE 9'S PRIOR COLUMN CARRIES THE SAME NOTE THE OTHER THREE SHEETS DO.
//
// Pages 6, 7 and 8 mark their PRIOR heading and date the comparative; page
// 9 prints PRIOR five times and marked none — on the sheet where the
// comparative is most treacherous, since creditor days prior is a 365-day
// annualisation taken over a 250-day comparative. Same sentence
// (`priorColumnFootnote`), numbered after the debtor-days note because this
// page's numbering is its own.
const scorecardPriorNote = comparativePeriod === null
  ? null
  : priorColumnFootnote(comparativePeriod, set.currentWindow, 2);
// AND EVERY SCORED ROW STANDING ON A FIGURE THE PACK QUALIFIES SAYS SO.
//
// Sheet 9 prints `Current ratio · (0.14) · target 1.50 · MISSED` in red on
// a numerator sheet 7 calls a balance that cannot be held; Brightsphere's
// ONLY scored target is the same ratio, on current assets of (3 372). The
// pack scored a judgement against figures it disowns two pages earlier, and
// the cross-reference ran one way. Derived from `METRIC_INPUTS` — which
// ledger figures each ratio is taken on — so it cannot be true of one ratio
// and not the next.
//
// ONE NOTE FOR EVERY SCORED ROW THAT NEEDS ONE, AND THAT IS ARITHMETIC.
// Carried as its own footnote the sheet needs 256.11mm of a 255mm box —
// over by 1.11, and the smallest thing on that page is a footnote line at
// 3.88, so paying for it means dropping a note some earlier gate asked for.
// Folded into the debtor-days note it costs that note a third line and
// saves a whole footnote: net nothing, and both rows point at one place.
//
// The DISOWNED sentence leads, because the rows that carry the marker
// without a note of their own are the ratio rows, and a Current ratio
// marker landing on a note that opens "Debtor days on this page" is a
// pointer to the wrong subject.
//
// AND THE BALANCE-SHEET ARM ASKS PAGE 7 WHAT IT ACTUALLY SAID. It used to
// re-derive the rule over its own field list, which flagged a negative
// `cash` or `inventory` — neither of which is a row page 7 prints, so the
// footnote sent a director to a statement the balance sheet never made.
// One list, built once here, read by page 7's block and by this footnote.
const disowned = disownedBases(scorecard, debtorsBaseApplies, page7Impossible);
const disownedText = disownedBasesFootnoteText(disowned);
// THE WINDOW HALF IS BUILT SHORT, FOR THIS SHEET ONLY.
//
// Page 6's version of this sentence ends "Different windows: the two need
// not agree", and says "the same measure" where "it" will do — right there,
// on a sheet with room. Here the two clauses cost 110 characters the page
// does not have, page 12's Debtor days entry states the conclusion in those
// words, and the sentence in front of this one already says the ratio's
// base is qualified and unadjusted. The ANNUALISATION is what a director
// reading 213 against a 30-day target needs and it is taken from the same
// `PERIOD_COUNTERPARTS` datum page 6 prints, so the two sheets cannot come
// to disagree about it.
const debtorWindow = debtorDaysFootnote.length === 0 ? null
  : 'Debtor days here is the figure for the WHOLE reporting period, '
    + `${PERIOD_COUNTERPARTS['trend-debtor-days']!.wholePeriodBasis}; the trends page plots it `
    + 'a month at a time.';
const rowNoteText = [disownedText, debtorWindow]
  .filter((part): part is string => part !== undefined && part !== null)
  .join(' ');
const rowNote = rowNoteText === '' ? [] : [{ number: 1, required: true as const, text: rowNoteText }];
const flagged = new Set([
  ...disowned.map((d) => d.metric),
  ...(debtorDaysFootnote.length === 0 ? [] : ['debtor days']),
].map((m) => m.toLowerCase()));
const scoredOnDisowned = rowNote.length === 0 ? scorecard : scorecard.map((group) => ({
  ...group,
  rows: group.rows.map((row) => (
    flagged.has(row.metric.toLowerCase()) ? { ...row, footnote: 1 } : row
  )),
}));

  return { rowNote, scorecardPriorNote, scoredOnDisowned };
}

/**
 * PAGE 9 ITSELF — the scorecard, its caption, and the one optional note the
 * fitter is allowed to take.
 *
 * With `scorecardPageNotes` above, this is the whole sheet in one place; it
 * was 47 lines inside the composer's page list, almost all of it the reasoning
 * for why the "Scoring basis" note is optional and what it may not say.
 */
export function buildScorecardPage(
  score: { met: number; total: number },
  scorecard: PackScorecardGroup[],
  notes: ScorecardPageNotes,
): UnnumberedPage {
  const { rowNote, scorecardPriorNote, scoredOnDisowned } = notes;
  const scorecardPage = page(scorecardTitle(score.met, score.total), 'Scorecard', 'Performance', 'high', [
    { kind: 'scorecard', groups: scoredOnDisowned, priorFootnote: scorecardPriorNote?.number ?? null },
    commentary(scorecardCaption(scorecard)),
    // ONE note, not two. "Targets" and "Not meaningful" were definitions,
    // and they now sit with the other sixteen on the basis page — this page
    // could not afford them, dropped both for space and then printed "2
    // explanatory notes are not printed", telling a director that two
    // measures had lost their explanation without saying which. What stays
    // is the POINTER, because a director reading a column of MISSED and
    // NOT MEANINGFUL needs to know both are defined and where.
    // OPTIONAL, AND MEASURED RATHER THAN ASSUMED. On the live demo company
    // this page measures 255.05mm against a 255mm box before any prose is
    // trimmed — five hundredths of a millimetre — and the scorecard block
    // alone is 191mm of it, so this note is the only lever the fitter has
    // and it takes it. Making the note REQUIRED was tried and refuses the
    // pack: with the note held, the loop pops every footnote on the page
    // and is still 0.04mm over, so `assertFits` throws and the demo company
    // gets no pack at all. The five hundredths are not on the paper — the
    // browser lays the untrimmed page out around 252mm — but they are not a
    // wrong constant either: `SCORECARD_ROW_MM` is 7.45 against a CSS
    // arithmetic of 7.16 because a 27.07px row rounds up to 28 device
    // pixels, which is 7.41mm, and that allowance is real. See the fix
    // report for task 26; this needs a lever finer than a whole note.
    // AND WHAT "SCORED" EXCLUDES, because the page's headline counts three
    // scored targets over a table printing four. The fourth is on a metric
    // whose figures do not support it (`statusFor`: a null value is
    // NOT MEANINGFUL, whether or not a target is set on it), so it is
    // neither met nor missed and the count leaves it out. That was
    // recoverable from the Status column and from page 12's "Scored,
    // unscored and not meaningful" entry, and stated nowhere on the sheet
    // whose largest type does the counting. It costs this page NOTHING:
    // the note was 122 characters over a 174mm measure and is 194, both
    // two lines of 9.5pt — measured, on the one page in the pack with less
    // than two millimetres of slack.
    disclose('Scoring basis', [
      // ONE LINE SHORTER, AND WHAT WENT IS THE HALF PAGE 12 ALREADY MAKES.
      //
      // It opened "Each metric is scored against the platform's default
      // target" — which page 12's glossary states in those words, and which
      // the TARGET column states by existing. What a reader cannot get
      // anywhere but here is the EXCLUSION, because this sheet prints a
      // target on a row its own count leaves out; that clause and the
      // pointer both stay. The line buys the comparative-period footnote
      // above: the disclosure's is 4.94mm and the footnote's is 3.88, and
      // sheet 9 had 1.71mm.
      note('Definitions', 'A target the figures cannot support is not scored; the basis page defines the terms.'),
    ]),
  ], 'portrait', [
    ...rowNote,
    ...(scorecardPriorNote === null ? [] : [scorecardPriorNote]),
  ]);
  return scorecardPage;
}
