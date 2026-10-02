/**
 * Page 10's Scale note — which trend panels share one y-scale and which are
 * drawn on their own, derived from where each panel was actually drawn. Split
 * out of `packPageBlocks.ts` for the 300-line cap; `packTrendBlocks.ts` is
 * its one caller.
 */
import type { TrendPanels } from './packPageCharts';
import { note } from './packBlockBuilders';
import { inWords } from './packInWords';
import { formatPctLevel } from '@/lib/format/money';
import type { PackDisclosureNote } from './packPageModel';

/**
 * The Scale note, DERIVED from where each panel was actually drawn.
 *
 * It was one fixed sentence naming four money panels sharing one y-scale.
 * That was true of the pack it was written against and false of two others:
 * a pack that draws fewer panels, and — after `packTrendScale` — a pack
 * where one month's outlier makes the shared domain unusable for the small
 * series. A note about the drawing that is not derived from the drawing is a
 * claim a reader can disprove with a ruler.
 */
export function scaleNote(panels: TrendPanels): PackDisclosureNote | null {
  const parts: string[] = [];
  if (panels.sharedScale.length > 1) {
    // "none of them" of TWO panels, which is what the live demo pack printed
    // once Revenue and Operating expenses moved to their own scales.
    const every = panels.sharedScale.length === 2 ? 'neither of them' : 'none of them';
    parts.push(
      `${inWords(panels.sharedScale)} share one y-scale, so ${every} can look like it moved `
      + 'more than it did.',
    );
  } else if (panels.sharedScale.length === 1) {
    parts.push(`${panels.sharedScale[0]} is the only money panel on the shared y-scale.`);
  }
  // WHAT WAS HERE, AND WHY IT IS NOT: "Every panel labels the low and high of
  // its own axis, so a share of the range can be checked off the sheet."
  //
  // It was written when the panels WERE bare, and it is now a description of
  // something the sheet shows six times over — every panel prints its own two
  // axis values, and the caption directly above states the formula those
  // values are checked against ("a panel's percentage of it is that panel's
  // own axis, both ends printed, over that span"). Nothing a reader can do with the
  // sheet changes when the sentence goes.
  //
  // It is removed BECAUSE PAGE 10 HAD TO PAY FOR SOMETHING, and this is the
  // only line on it that says what the page already shows. The part-month
  // ratio clause below is a fact the pack did not state anywhere: two panels
  // end on a seven-day month and a ratio taken there is a different
  // measurement, not a smaller one. On the live demo company this sheet
  // composes with 2.5mm of slack and a line of 9.5pt costs 4.94, so the
  // clause and the sentence could not both stand. A fact that is not on the
  // paper beats a sentence describing the paper.
  // THE TWO REASONS A PANEL IS OFF THE SHARED SCALE, IN ONE SENTENCE, AND
  // THAT SAVED PAGE 10 A LINE OF 9.5pt.
  //
  // They were two sentences — one for the panels with too little range, one
  // reading "Gross margin and Debtor days are different units and keep their
  // own" — and on the live demo company, which is the only pack that reaches
  // BOTH arms, the note ran to five lines and the page was 7.4mm past its
  // sheet. Each reason is now a parenthesis on the panel it belongs to, so
  // nothing about which measure is off the scale for which reason is lost,
  // and the "slopes are not comparable" caution — which only the first arm
  // used to carry — now covers the ratio panels too, which is the direction
  // that gains a reader something.
  const offShared: string[] = [];
  if (panels.ownScale.length > 0) {
    // `formatPctLevel`, not `${n}%` — see `moneyPanel`: the panel title and
    // this note print the SAME share two centimetres apart, and one of them
    // was dropping a trailing zero.
    // AND THE SHARE IS NOT IN BRACKETS, BECAUSE BRACKETS ARE THE SIGN.
    //
    // Page 12 declares "In brackets — (12 345) — for money, percentages and
    // ratios. No minus sign is used in this pack", and this sentence printed
    // "Revenue (1.0%) and Operating expenses (1.6%)" — two POSITIVE shares,
    // which under the pack's own rule read as negative 1.0% and negative
    // 1.6%. The same two numbers print unbracketed as positives in the panel
    // captions on the same sheet: one quantity, one sheet, two glyphs, one of
    // them meaning the opposite sign.
    //
    // The brackets here were parentheses, not the notation — which is the
    // trap, because on this sheet both readings are live. Everywhere else the
    // pack writes a negative percentage in WORDS ("a negative 1522.9%") for
    // exactly this reason: to keep the bracket meaning one thing.
    const named = inWords(panels.ownScale.map((p) => `${p.name} at ${formatPctLevel(p.sharePct)}`));
    // WHAT THE PERCENTAGE IS OF, IN THE SENTENCE THAT MAKES THE CLAIM. The
    // page asserted "1.1% of the shared range" and printed nothing a reader
    // could check it against, so a reviewer took the spans off the two
    // figures in each panel's own title — 2 to 29 against 15 to 41 — got
    // near-identical numbers, and reported the two claims as irreconcilable.
    // They are not: the percentage is the span of a panel's own AXIS over the
    // shared span, not the movement between the months its title names.
    // But a share of an unstated number is not a disclosure, whether or not
    // the arithmetic behind it is right.
    //
    // AND THE AXIS IS THE READING BECAUSE THE AXIS IS WHAT IS PRINTED. The
    // page said "high-to-low range" and computed the axis, and the two agree
    // on every panel whose low is nil — which is every panel any gate had
    // checked until the twelfth read the operating-expenses panel, whose
    // series runs 8 to 58: high-to-low is 50 (1.4% of 3 529) and the printed
    // figure was 1.6%. The definition moved rather than the arithmetic,
    // because a panel prints its two AXIS ends and nothing else, so the axis
    // reading is the only one a director can reproduce off the sheet — which
    // is the whole point of printing the denominator. It is also the quantity
    // the split is decided on (`OWN_SCALE_SHARE`): how much of the shared
    // plot this panel would occupy if it stayed.
    //
    // NO SECOND COPY OF THE RANGE. It was stated here as well, because the
    // fitter may take this note and the percentages would then cite an
    // undisclosed denominator. The commentary block above — which the fitter
    // never touches — carries the range, and every panel now prints the ends
    // of its own axis, so the number is on the sheet twice already.
    offShared.push(`${named}, too little of it to register`);
  }
  if (panels.ownUnits.length > 0) {
    offShared.push(`${inWords(panels.ownUnits)}, in different units`);
  }
  if (offShared.length > 0) {
    // "the panels above", not "the SHARED-SCALE panels", was a position on
    // the sheet rather than the class it means — and the top-right panel has
    // nothing above it, so for that one the caution named nothing. The
    // panels are laid out two across in an order the data decides, so any
    // wording that points by position is wrong on some company.
    // JOINED WITH ", and ", NOT `inWords`. Each entry now carries its reason
    // as a comma-delimited aside rather than in brackets, so `inWords`'s bare
    // " and " would run the second group's subject into the first group's
    // aside; and the clause that follows needs its own comma to close the
    // last aside before the verb.
    parts.push(`${offShared.join(', and ')}, are on their OWN scales, so their slopes are not `
      + 'comparable with the shared-scale panels.');
  }
  // A pack that draws no panel at all has no scale to describe, and a headed
  // note with an empty body is a heading the page cannot honour.
  if (parts.length === 0) return null;
  return note('Scale', parts.join(' '));
}
