/**
 * Page 5's memorandum on EBITDA, the pack's one non-IFRS measure. Split out
 * of `packMonthlyResults.ts` for the 300-line cap; that file re-exports
 * `ebitdaMemoSentence`, so every caller still imports it there.
 */
import { formatStatementFigure, inProse, type MoneyScale } from '@/lib/format/money';
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import { packFiguresToFinancialData } from './packScorecard';
import { DA_ADD_BACK } from './packDefinitions';

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
 * The figures go through `inProse`, which says "nil" where `formatStatementFigure`
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
  const current = inProse(formatStatementFigure(ebitdaOf(set.current), { scale }));
  const comparative = set.prior === null
    ? 'There is no comparative period to state it against.'
    : `The comparative period's is ${inProse(formatStatementFigure(ebitdaOf(set.prior), { scale }))}.`;
  // AND IT NO LONGER POINTS AT THE FOOTER. "which the footer of every sheet
  // states" is a description of the sheet's own furniture — the running
  // footer carries the period on all twelve pages — and it cost this note a
  // line of 9.5pt on both companies. That line is what pays for the
  // largest-figure sentence in the caption below. The fact it restated is
  // still on every sheet; what went was the sentence saying so.
  // AND IT IS TRUE ON A COMPANY THAT CHARGED NOTHING, WHICH IT WAS NOT.
  //
  // It read "plus the depreciation and amortisation CHARGED in the period".
  // Brightsphere's movement on those accounts is a net CREDIT — more reversed
  // out than posted in — so page 12's reconciliation reads (1 819) plus (152)
  // and lands at (1 971), EBITDA BELOW operating profit. Against a sentence
  // saying the add-back is what was charged, that arithmetic reads as a sign
  // error: the exact misreading page 12's own entry was made sign-aware to
  // prevent. The wording was fixed on the glossary page and left as
  // boilerplate here.
  //
  // MOVEMENT, NOT A SECOND SIGN-AWARE BRANCH. Naming the credit here as well
  // costs 86 characters and Brightsphere's sheet 5 answers by dropping a note
  // — buying an explanation with an explanation, which is the trade this
  // branch keeps refusing. "The movement on depreciation and amortisation"
  // is true whichever way those accounts ran, and page 12 carries the sign
  // clause in full beside the reconciliation that prompts the question.
  //
  // AND THE LENGTH IS MEASURED, NOT COUNTED. "the period's movement on
  // depreciation and amortisation" is one character SHORTER than the phrase
  // it replaces and still costs sheet 5 a line — the words break differently
  // — and the fitter answers by dropping a note from this very disclosure.
  // The period is already this sentence's subject, so dropping "the
  // period's" costs nothing and buys the line back. Both accounts stay
  // named: EBITDA is defined by its D and its A, and a sheet that presents a
  // non-IFRS measure has to say what is in it.
  return `EBITDA for the reporting period is ${current}. ${comparative} It is operating profit `
    + `plus ${DA_ADD_BACK}, and it is presented because a `
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
  return calculateExtendedRatios(packFiguresToFinancialData(f)).ebitda;
}
