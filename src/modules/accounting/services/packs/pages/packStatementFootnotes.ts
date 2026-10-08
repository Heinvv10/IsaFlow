/**
 * The pack's one rounding convention in each of the wordings it prints, and
 * the footnotes a statement page carries — the rounding note and which period
 * the prior column is. Split out of `packBasis.ts` for the 300-line cap; that
 * file re-exports every export here, so each caller still imports it there.
 */
import type { PackComparativePeriod, PackFootnote } from './packPageModel';
import { comparativeLengthClause } from './packPeriodLabel';
import type { PeriodWindow } from '@/modules/accounting/services/reports/priorPeriod';
import { PACK_SCALE } from './packScale';

/**
 * Every statement stated in a scale needs this, and none of the pack's pages
 * carried it. Rounded components genuinely do not always sum to a rounded
 * total — a reader who adds a column and finds it a thousand out is entitled
 * to know that is the rounding rather than an error in the pack.
 */
const COMPONENTS_CLAUSE = 'components may not add exactly to the totals shown';

/** `clause` as a sentence of its own — the only difference between the two
 *  wordings below, and therefore the only thing that can drift. */
function asSentence(clause: string): string {
  return `${clause[0]!.toUpperCase()}${clause.slice(1)}.`;
}

export const ROUNDING_COMPONENTS_NOTE =
  `Figures are rounded to the nearest ${PACK_SCALE}, so ${COMPONENTS_CLAUSE}.`;

/**
 * AND THE HALF OF ROUNDING THAT IS NOT ABOUT ADDING UP.
 *
 * The note above covers a column that does not foot. It says nothing about a
 * QUOTIENT, and on a small revenue base the quotient is where rounding does
 * its real damage: the demo pack's revenue is R101 424, printed 101, and its
 * gross margin of (1 329) over that base prints (1310.8%) where a director
 * dividing the two figures in front of them gets (1315.8%). Five percentage
 * points, on the two most prominent numbers in the pack — page 3's headline
 * tile and page 6's headline — with nothing anywhere saying why. The figures
 * were right and the disclosure was missing, which is the more expensive of
 * the two on a document whose argument is that its numbers can be checked.
 *
 * IT NAMES WHAT IT IS TRUE OF, BECAUSE TWO FAMILIES OF PERCENTAGE PRINT IN
 * THIS PACK AND THEY ARE COMPUTED DIFFERENTLY ON PURPOSE. A margin, a change
 * percentage, a share of revenue in a statement column and every scorecard
 * ratio come off the ledger's own unrounded amounts, and those are the ones
 * that will not reproduce. Page 10's scale shares and page 5's biggest-month
 * share are taken on the PRINTED figures, deliberately (`atScale`), because
 * those two sheets invite the reader to do the division off the paper — so a
 * blanket "ratios are computed before rounding" would be false exactly where
 * the pack has gone to the most trouble to be checkable. Saying "a ratio
 * taken on the unrounded figures" scopes the claim to the family it is about
 * and says nothing about the other, which is the difference between a rule
 * this document keeps and one it states and draws around.
 *
 * AND IT IS ONE LINE OF PAPER, WHICH IS WHAT IT COST. Page 12 composes with
 * about 2mm to spare on the tightest fixture, and this clause is four lines
 * of an 83mm column. It is paid for out of the `Not meaningful (n/m)` entry,
 * which said "never a zero — which would say the measure was taken and found
 * to be nothing" immediately before defining the dash as exactly that zero,
 * and closed by restating "too small to show at this scale" a second time.
 * Restatement for a fact, which is the only trade this page has left.
 */
export const ROUNDING_RATIOS_NOTE =
  'A ratio taken on the unrounded figures may not reproduce from the rounded ones beside it.';

/**
 * The pack's ONE rounding convention, both halves of it — and it does NOT
 * restate the scale, because the fact two rows above it on page 12 states it.
 *
 * It used to be `${ROUNDING_COMPONENTS_NOTE} ${ROUNDING_RATIOS_NOTE}` exactly,
 * so the basis fact opened "Figures are rounded to the nearest R'000" under a
 * `Standard and currency` fact reading "IFRS for SMEs. ZAR in R'000." — the
 * scale said twice in one two-column block, and a fourth line of an 83mm
 * column. That line is what page 12 had left, and the `Reporting entity` fact
 * is what it now buys (see `buildBasisPage`): the pack names the entity it
 * reports on and states that nothing is consolidated into it, paid for out of
 * a restatement rather than out of a fact.
 *
 * BOTH WORDINGS ARE STILL ONE CLAIM, WHICH IS WHAT THE OLD `startsWith`
 * INVARIANT WAS PROTECTING. `COMPONENTS_CLAUSE` is the claim, written once;
 * the footnote wraps it in the scale because it prints alone on a statement
 * sheet and has to stand up there, and page 12 sets it as its own sentence
 * because the scale is already beside it. `packRoundingDisclosure.test.ts`
 * asserts the shared clause rather than the shared prefix, so the two can
 * still never say different things about how this pack rounds.
 */
export const ROUNDING_NOTE = `${asSentence(COMPONENTS_CLAUSE)} ${ROUNDING_RATIOS_NOTE}`;

/**
 * The same convention as a page footnote, for the statement pages.
 *
 * THE COMPONENTS HALF ONLY, AND THAT IS MEASURED RATHER THAN CHOSEN. The
 * ratio clause belongs here too — the `% of revenue` column and the change
 * percentages print on these very sheets, which is where a reader meets the
 * discrepancy — and it does not fit. Carried in footnote 1 it takes the
 * required window note off sheet 5 on both companies and puts page 3 past
 * its box; the suite goes red on four files. Page 3's Scale note is the same
 * trade for the same reason.
 *
 * It is the same STRING either way — `ROUNDING_RATIOS_NOTE` is written once
 * and page 12 prints both halves — so the footnote and the basis page can
 * never disagree about how this pack rounds; the footnote simply says less,
 * and a reader following it lands on the page where the pack declares every
 * one of its conventions.
 */
export const ROUNDING_FOOTNOTES: PackFootnote[] = [{ number: 1, text: ROUNDING_COMPONENTS_NOTE }];

/**
 * A statement page's footnotes: the rounding note, and — when the page shows a
 * prior column — WHICH period that column is.
 *
 * Spec §7.2 asks that the comparative be the period claimed in the header, and
 * a column headed only "Prior" claims nothing a reader can check. The text is
 * built from `comparative.label` rather than re-formatted here, so the printed
 * claim and the one the integrity gate checks are the same string; a second
 * formatting of the same dates is how the page and the gate start disagreeing.
 *
 * AND ITS LENGTH, BESIDE THE COLUMN IT QUALIFIES. 1 January to 7 September
 * 2026 is 250 days and 26 April to 31 December 2025 is also 250 — which is
 * what makes the prior column and every change percentage taken across it
 * comparable at all, and the pack stated it
 * nowhere. `comparativeLengthClause` MEASURES the two windows rather than
 * asserting a match, so a pack whose comparative is a different length prints
 * the mismatch in the same place.
 *
 * HERE AND NOT ON PAGE 12, AND THAT WAS MEASURED. Page 12's own "Comparative
 * period" fact reads across an 83mm column at 8.5pt and is one line with five
 * characters to spare, so any clause at all takes it to two — and on the live
 * demo fixture whose EBITDA bridge rounds, page 12 composes at 252.41mm in a
 * 255mm box, so that line costs 4.24mm the sheet does not have and
 * `fitPageToBox` answers by dropping the Colour key. This footnote is one
 * line with 57 characters spare on all three statement pages, and it prints
 * directly under the column it is about rather than three sheets away.
 */
export function statementFootnotes(
  comparative: PackComparativePeriod | null,
  /** The window the ACTUAL column was read over — see `comparativeLengthClause`. */
  reportingWindow: PeriodWindow,
): PackFootnote[] {
  if (comparative === null) return ROUNDING_FOOTNOTES;
  return [...ROUNDING_FOOTNOTES, priorColumnFootnote(comparative, reportingWindow, 2)];
}

/**
 * THE COMPARATIVE'S PERIOD, AS ONE SENTENCE FOR EVERY SHEET THAT PRINTS A
 * PRIOR COLUMN.
 *
 * Pages 6, 7 and 8 each marked their PRIOR heading and pointed here. Page 9
 * prints PRIOR five times and marked none — on the sheet where the
 * comparative is most treacherous: its day counts are measured over the
 * comparative's own days, and the prior current and cash ratios both read
 * (0.05). The rule was applied to three sheets of four.
 *
 * It takes its NUMBER from the caller because page 9's footnote numbering is
 * its own — the debtor-days note is 1 there when the trends page draws that
 * panel — and it is one function because four sheets stating the comparative
 * period in four places is four places for it to drift.
 */
export function priorColumnFootnote(
  comparative: PackComparativePeriod,
  reportingWindow: PeriodWindow,
  number: number,
): PackFootnote {
  return {
    number,
    text: `The prior column is the period ${comparative.label} — `
      + `${comparativeLengthClause(reportingWindow, comparative)}`,
  };
}
