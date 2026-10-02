/**
 * Page 10's blocks — the small multiples (or why none are drawn), the
 * commentary that carries the shared range, the reading notes and the
 * panels-not-drawn disclosure. Split out of `packPageBlocks.ts` for the
 * 300-line cap; that file re-exports `buildTrendBlocks`, so every caller
 * still imports it there.
 */
import { trendsCaption } from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { TRENDS_PANELS_SPECIFIED, type TrendPanels } from './packPageCharts';
import { PANEL_OMITTED_RULE } from './packShortenedPanels';
import { commentary, disclose, mustDisclose, note } from './packBlockBuilders';
import { trendWindowNote } from './packTrendCrossReference';
import { scaleNote } from './packTrendScaleNote';
import type { PackDisclosureNote, PackPageBlock } from './packPageModel';

/** Page 10 — the small multiples (or why none are drawn), commentary, the
 *  shared-scale explanation, and — only when the pack's six panels are not
 *  all drawable — which are missing and why. */
export function buildTrendBlocks(
  panels: TrendPanels,
  /**
   * Whether the page a panel points at prints a comparative figure for it,
   * read off the COMPOSED page — see `trendWindowNote`. Optional so the many
   * tests that build a panel set alone keep working; `boardPackPages` passes
   * the real reading.
   */
  printsComparative?: (panelId: string) => boolean,
): PackPageBlock[] {
  const drawn = panels.panels;
  const trendBlocks: PackPageBlock[] = [];
  if (drawn.length > 0) trendBlocks.push({ kind: 'smallMultiples', panels: drawn });
  else {
    trendBlocks.push(mustDisclose('No trend series', [
      note('Why', 'No monthly series covers this period, so no panel can be drawn. Nothing is inferred from the period totals in its place.'),
    ]));
  }
  // THE DENOMINATOR RIDES WITH THE FIGURES, NOT WITH THE PROSE ABOUT THEM.
  //
  // Panels drawn on their own scale are titled "Own scale — 1.1% of the
  // shared range", and one caption reads "drop it and the shared range
  // shrinks by 52.4%". What the shared range IS was stated only in the Scale
  // note below, which is a disclosure the fitter may take — and on the live
  // demo company it takes it, leaving three percentages of an undisclosed
  // denominator on the sheet. Brightsphere prints the note and its captions
  // carry no percentages, so the one pack that needed the number was the one
  // that lost it.
  //
  // A commentary block is not a disclosure and `fitPageToBox` never touches
  // one, so the range stated here cannot be separated from the claims that
  // cite it. The Scale note keeps its own copy — it is making an argument
  // about comparability and needs the number in the sentence — and the two
  // are one string off `panels.sharedRange` rather than two formattings of
  // one domain.
  const citesShare = panels.ownScale.length > 0 && panels.sharedRange !== null;
  // AND WHAT THE SPAN IS TAKEN ACROSS, which is the half a reader cannot
  // derive from the sheet. The shared domain is computed over EVERY money
  // series before any of them is moved off it (`moneyPanelScales`), so on the
  // live demo pack it runs (1 621) — cash's low — to 1 908 — net profit's
  // high — and the counterfactual in the net-profit caption lands on 58,
  // which is the OPERATING EXPENSES axis's high. Every one of those figures
  // is right. But the Scale note two centimetres below says net profit and
  // cash share the scale while revenue and operating expenses are on their
  // own, so a director recomputing the caption's claim over the two series
  // the sheet says share it gets (1 621) to (11) and reads the panel as
  // wrong. The domain was never stated, and a claim whose domain is unstated
  // is unverifiable however sound its arithmetic — the same failure the
  // sentence beside it was written to fix when it started printing the
  // denominator. Stated HERE because this is where the range is defined, and
  // in the COMMENTARY because `fitPageToBox` never takes one: the Scale note
  // is a disclosure and can be dropped, taking the definition with it.
  // It costs no line — the block wraps with the clause inside its existing
  // measure, and page 10 composes at 248.24mm of 255 with it and without it.
  // AND WHAT THE SPAN IS TAKEN ACROSS, which is the half a reader cannot get
  // off the sheet. The shared domain is computed over EVERY money series
  // before any of them is moved off it (`moneyPanelScales`), so on the live
  // demo pack it runs (1 621) — cash's low — to 1 908 — net profit's high —
  // and the counterfactual in the net-profit caption lands on 58, which is
  // the OPERATING EXPENSES axis's high. Every one of those figures is right.
  // But the Scale note below says net profit and cash share the scale while
  // revenue and operating expenses are on their own, so a director who
  // recomputes the caption's claim over the two series the sheet says share
  // it gets (1 621) to (11) and reads the panel as wrong. A claim whose
  // DOMAIN is unstated is uncheckable however sound its arithmetic — the same
  // failure this sentence was written to fix when it started printing the
  // denominator, one level up.
  //
  // IT IS PAID FOR OUT OF THE SENTENCE, NOT ADDED TO THE PAGE. Sheet 10
  // composes at 252.47mm of 255 on the tightest fixture and this block wraps
  // with 17 characters to spare; a line costs 5.29mm, and `fitPageToBox`
  // answers by dropping the Period note — the month-versus-period
  // reconciliation — so the sheet would lose that to gain this. "over that
  // span" goes: "a panel's percentage OF IT" already names the span it is
  // taken over, and the clause was a second naming of the same quantity.
  // Net 10 characters, measured on the composed page: 252.47mm before and
  // after, both notes still printed.
  //
  // THE COUNT IS DERIVED, never the literal four. `sharedScale` and
  // `ownScale` are the money panels, split by which domain each was drawn
  // against; `ownUnits` is the ratio panels, which are in no money domain and
  // are excluded from the shared span by construction.
  //
  // AND "ALL" WAS THE WORD THAT MADE IT FALSE. The span is TAKEN over every
  // money panel and DRAWN on the ones whose own range is not a twentieth of
  // it — so the demo sheet said "over all 4 money panels" three lines above a
  // Scale note reading "Net profit and Cash share one y-scale" and "Revenue
  // (1.0%) and Operating expenses (1.6%) … are on their OWN scales". Two
  // sentences on one sheet, one of them wrong, about the only claim the page
  // makes that a reader cannot check by looking.
  //
  // The count of panels DRAWN on it is the fact that was missing, and it has
  // to be bought at no cost: this block wraps with a handful of characters to
  // spare and `fitPageToBox` answers one more line by dropping the Period
  // note — the month-versus-period reconciliation — so the sheet would lose
  // that to gain this. BOTH facts are owed — the span is taken over every
  // money panel, which is what makes it exceed what the shared-scale panels
  // alone reach (`packTrendScaleDisclosure`), and DRAWN on the subset whose
  // own range is not a twentieth of it. Six characters buys both: "all" was
  // the word doing the damage and it goes, and ", drawn on 2" is what
  // replaces it. Measured, not estimated — eleven characters is one line too
  // many on the live demo sheet and six is not.
  const moneyPanels = panels.sharedScale.length + panels.ownScale.length;
  trendBlocks.push(commentary(citesShare
    ? `${trendsCaption(drawn)} The shared y-scale spans ${panels.sharedRange}, over `
      + `${moneyPanels} money panels, drawn on ${panels.sharedScale.length}; a panel's percentage `
      + 'of it is its own axis, both ends printed.'
    : trendsCaption(drawn)));
  // The window note is DERIVED from the panels this page draws — see
  // `trendWindowNote`. Pushed unconditionally, it printed "Gross margin is
  // printed on this page and on the income statement page" two centimetres
  // above a disclosure saying no gross-margin panel could be drawn.
  const windowNote = trendWindowNote(drawn, panels.partMonthLeftOut, printsComparative);
  // THE SCALE NOTE FIRST, AND THAT IS A REVERSAL. It used to run second, so
  // that the fitter — which takes a disclosure's LAST note first — would take
  // it before the window note, on the reasoning that the window note explains
  // why two sheets print different figures for one measure while the scale
  // note only describes what a reader can already see.
  //
  // That stopped being true when the panels started CLAIMING a share of the
  // shared range in their own titles. On the live demo company two panels are
  // titled "Own scale — 1.1% of the shared range" and a caption reads "drop
  // it and the shared range shrinks by 52.4%", and the only statement of what
  // the shared range IS — its low, its high and its span — is in this note.
  // The page dropped both notes and printed a footnote saying so, leaving
  // three percentages of an undisclosed denominator on the sheet: exactly the
  // unverifiable claim the denominator was added to fix. Brightsphere prints
  // the notes and its captions carry no percentages, so the one pack that
  // needed the definition was the one that lost it.
  //
  // A note the page's own figures cite is not commentary, so the block is
  // REQUIRED below: its first note can never be taken, and the scale note is
  // now that first note. The window note is what a short page gives up, and
  // the page says so.
  const readingNotes = [scaleNote(panels), windowNote]
    .filter((n): n is PackDisclosureNote => n !== null);
  // ONE COLUMN, deliberately: two columns were tried and are DEARER here.
  // `break-inside: avoid` means a two-note block balances to the taller note
  // rather than to half the lines, so the ten-line Period note would set the
  // block's height with the five-line Scale note beside it — 52.7mm against
  // 47.8mm in a single measure. Columns pay off on page 12's sixteen terms,
  // not on two paragraphs.
  // OPTIONAL, and that was measured rather than assumed. Held REQUIRED — so
  // the scale note could never be taken — the live demo page needs 257.1mm of
  // a 255mm sheet with every other lever spent, and `assertFits` refuses the
  // pack. Its own model is accurate to 0.13mm on this page, so those two
  // millimetres are on the paper and not in the ruler. What the reorder above
  // buys is the ONE-drop case: the window note goes first, and the scale note
  // survives every page that is short by one note rather than two. What
  // carries the denominator when both go is the commentary block above.
  if (readingNotes.length > 0) trendBlocks.push(disclose('Reading these panels', readingNotes));
  if (drawn.length < TRENDS_PANELS_SPECIFIED) {
    trendBlocks.push(mustDisclose('Panels not drawn', [
      // NO CLAUSE NUMBER. This printed "Spec §4.A asks for 6 panels and 4 are
      // drawn" — the section number of this project's own internal
      // specification, quoted to a board. What a director needs is which six
      // a board pack carries and which of them this company's ledger could
      // not support; the authority for the six is not their business.
      // AND THE TWO COUNTS ARE THE SAME KIND OF THING. It read "tracks SIX
      // measures … and 4 OF THE SIX", a word and a digit for one number in
      // one sentence, on a page whose caption two blocks above opens "4
      // measures are drawn over the period". The pack sets counts as digits
      // everywhere else — "2 caveats qualify these figures", "0 of 3 scored
      // targets" — so the word was the outlier. Both are taken from
      // `TRENDS_PANELS_SPECIFIED` now rather than typed, which is also what
      // stops the sentence claiming six on the day the spec asks for seven.
      note('Why', `A board pack tracks ${TRENDS_PANELS_SPECIFIED} measures on this page — revenue, gross margin %, operating expenses, net profit, cash and debtor days — and ${drawn.length} of the ${TRENDS_PANELS_SPECIFIED} could be drawn for this company. ${PANEL_OMITTED_RULE}: gross margin % and debtor days both need positive revenue, and no period here had any. Nothing is inferred in its place.`),
    ]));
  }
  return trendBlocks;
}
