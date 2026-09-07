/**
 * Block builders for the four board pack pages whose content assembly
 * outgrew a one-line `page(...)` call in `boardPackPages.ts` — page 3
 * (highlights), page 7 (position), page 8 (cash) and page 10 (trends).
 * `boardPackPages.ts` stays a SEQUENCE that says which page gets which
 * blocks; this is where the conditional "which disclosure applies" logic
 * for those four pages lives, alongside `packStatementTables.ts` and
 * `packPageCharts.ts` — the same split, for the same reason: nothing here
 * computes a figure, it only decides how to present ones already built.
 *
 * `note`, `disclose` and `commentary` live here rather than in
 * `boardPackPages.ts` because every block builder below needs them; the
 * sequence file imports them back for its own remaining simple pages.
 */
import {
  boardActionItems,
  cashCaption,
  positionCaption,
  negativeAssetsSentence,
  negativeEquitySentence,
  tileCaption,
  trendsCaption,
} from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { TRENDS_PANELS_SPECIFIED, type PackCashBridge, type TrendPanels } from './packPageCharts';
import type { SelectedMatters } from './packMattersPrinted';
import { trendWindowNote } from './packTrendCrossReference';
import { formatMoney, type MoneyScale } from '@/lib/format/money';
import { disproportionatePlugSentence } from '@/modules/accounting/services/packs/figures/packWaterfallIntegrity';
import { ROUNDING_NOTE } from './packBasis';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type {
  PackChartSpec,
  PackComparativePeriod,
  PackDisclosureNote,
  PackFootnote,
  PackKpiTile,
  PackNarrative,
  PackPageBlock,
  PackTable,
} from './packPageModel';

export const note = (heading: string, body: string): PackDisclosureNote => ({ heading, body });

export const disclose = (
  heading: string,
  notes: PackDisclosureNote[],
  /** Two columns for a disclosure whose notes are a LIST rather than an
   *  argument — see `PackDisclosure.columns`. */
  columns?: 2,
): PackPageBlock => ({
  kind: 'disclosure',
  disclosure: columns === undefined ? { heading, notes } : { heading, notes, columns },
});

/**
 * A disclosure the pack is NOT free to leave off the page — §3.5's
 * negative-equity consequence, the negative-assets note beside it, the
 * unexplained-plug sentence the integrity gate demands, and every "why this
 * chart is not here" explanation.
 *
 * The distinction exists for `fitPageToBox`: a page short of paper drops the
 * pack's optional prose first and reaches these last. Without it the trimmer
 * would take whichever note happened to be at the bottom of the page, and on
 * page 7 that is the negative-equity callout.
 */
export const mustDisclose = (heading: string, notes: PackDisclosureNote[]): PackPageBlock => ({
  kind: 'disclosure',
  disclosure: { heading, notes, required: true },
});

/**
 * A deterministic caption, carried as a DERIVED narrative — R-P49.
 *
 * It used to ride in a `disclosure` block: `PackNarrative.status` had no
 * 'derived' member and `NarrativeColumns` printed a body only for
 * 'approved', so the only way to make a machine-written caption render was
 * to claim a human had signed it — a false statement on every page of the
 * pack. The status now exists and the renderer LABELS it as derived, so the
 * workaround is gone and the caption says what it is.
 */
export const commentary = (body: string): PackPageBlock => ({
  kind: 'narrative',
  narrative: { status: 'derived', body, actions: [] },
});

/** Page 3's one footnote — spec §4.A page 3's multi-year note under each
 *  tile. Referenced by `PackKpiTile.trendFootnote`, which the tile model
 *  leaves null because the PAGE owns its footnote numbering. */
const SPARKLINE_FOOTNOTE = 1;

/** Page 3 — the whole period in one page. Spec §4.A: eight tiles, each with
 *  its delta and the basis that delta is measured against. */
export function buildHighlightsBlocks(
  tiles: PackKpiTile[],
  scale: MoneyScale,
  currency: string,
  /** The comparative period the pack states on its basis page, or null where
   *  there is none. The page says which of those two it is, ONCE, and every
   *  tile caption is consistent with it — see `PackKpiDeltaAbsence`. */
  comparative: PackComparativePeriod | null,
  /** The stub at the end of the monthly series, or null where the period ends
   *  on a whole month. Page 3's tiles cover the WHOLE period, whose last month
   *  is this one — see the note below. */
  partial: PackTrendPoint | null,
): { blocks: PackPageBlock[]; footnotes: PackFootnote[] } {
  const highlightTiles = tiles.map((tile) =>
    tile.sparklineSvg === null ? tile : { ...tile, trendFootnote: SPARKLINE_FOOTNOTE },
  );
  const sparklineCount = highlightTiles.filter((t) => t.sparklineSvg !== null).length;
  return {
    blocks: [
      { kind: 'kpiTiles', tiles: highlightTiles },
      // One derived line PER TILE, not a restatement of the page title — a
      // commentary block echoing the heading pads the page's density with
      // repetition, which is the opposite of what spec §5.7 asks for.
      disclose('Commentary', highlightTiles.map((tile) => note(tile.label, tileCaption(tile)))),
      disclose('Reading these tiles', [
        // ONE TRUTH ABOUT THE COMPARATIVE, AND IT IS THE DOCUMENT'S OWN.
        //
        // This note said "no comparative period to measure against" while the
        // statement pages printed a prior column and the basis page named the
        // comparative's dates — because a tile with no movement and a pack
        // with no comparative period had been collapsed into one null. Both
        // halves now read the SAME `comparativePeriod` the basis page prints,
        // so the pack cannot say one thing on sheet 3 and another on sheet 12.
        note('Comparison basis', comparative === null
          ? 'This pack has no comparative period, so no tile shows a movement and none is shown as a move from zero.'
          : `Each movement is measured against ${comparative.label} — the comparative period the basis page states, and the prior column the statement pages print.`),
        // SHORTENED, AND WHAT WENT WAS THE RESTATEMENT. It read "— the
        // comparative period carries no value for that measure, or its prior
        // figure is not a positive base —", which is the Commentary block
        // three centimetres above this one, verbatim: those two sentences ARE
        // the captions `tileCaption` writes. The fact this note exists to
        // disclose is that a blank movement is explained rather than unknown,
        // and that a movement is never drawn from zero; both survive. It cost
        // the sheet one line of 9.5pt, which is what sheet 3 was over by.
        ...(comparative === null ? [] : [note('Absent comparatives',
          'A tile with no movement says why in its own caption above. A movement is never shown as a move from zero.')]),
        // AND THAT THE PERIOD STOPS PART-WAY THROUGH ITS LAST MONTH.
        //
        // Page 3 was the only substantive sheet in the pack with no
        // part-month statement, and it is the sheet a director reads first
        // and the one most often forwarded on its own. Every tile on it — the
        // two margins, net profit, working capital, debtor days — is measured
        // over a period whose final month is a stub, and pages 5, 8, 10 and
        // 12 each say so about their own figures while this page said
        // nothing.
        //
        // A NOTE, NOT A FOOTNOTE. It is about every tile on the sheet rather
        // than about one of them, and page 3 already carries one anchored
        // footnote; a second, unanchored, superscript beside it is the orphan
        // the tenth gate called conspicuous.
        //
        // AND IT IS ONE LINE. The first draft ran to two and Brightsphere's
        // sheet 3, which composes at 98.7% of its box, paid for it by dropping
        // the Scale note and printing "2 explanatory notes are not printed" —
        // buying a new statement with an old one, which is what every round on
        // this branch has been caught doing.
        ...(partial === null ? [] : [note('Part month',
          `Every tile covers the whole period, whose last month — ${partial.label} — `
          + `is ${partial.daysCovered} of its ${partial.daysInMonth} days.`)]),
        note('Scale', `Figures are in ${scale} (${currency}). ${ROUNDING_NOTE}`),
      ]),
    ],
    // AND THE SPARKLINE IS A DIFFERENT WINDOW FROM THE TILE IT SITS IN.
    // The figure is the whole reporting period; the line beside it is a month
    // at a time, which is the same month-versus-period divergence the trends
    // page carries its own note about — see `trendWindowNote`.
    footnotes: [{ number: SPARKLINE_FOOTNOTE, text: `Each tile's figure covers the WHOLE reporting period; the sparkline beside it runs over the monthly trend series, a different window. ${sparklineCount} of ${highlightTiles.length} tiles carry one; the rest have no monthly series behind them and show none rather than a line drawn from a single point.` }],
  };
}

/**
 * Page 4 — spec §4.A's two prose columns, and the note that says where each
 * of them comes from.
 *
 * NO TABULAR FIGURES, per §4.A: a narrative block and a disclosure block,
 * both prose. The action panel is DERIVED from the same matters the matters
 * page tabulates, so it is populated whether or not a human has approved
 * commentary — which is what keeps this page from being the one italic line
 * at 1.0% fill that shipped in the first rendered pack (R-P57).
 *
 * The note is not padding. A director reading a pack whose commentary column
 * says "pending approval" needs to know that this is a state of the pack and
 * not a rendering fault, and that the panel beside it was not written by the
 * person who will sign the commentary.
 */
export function buildCommentaryBlocks(
  narrative: PackNarrative,
  selection: SelectedMatters,
): PackPageBlock[] {
  return [
    { kind: 'narrative', narrative, boardActions: boardActionItems(selection) },
    disclose('How this page is prepared', [
      // NEITHER SENTENCE NAMES A COLUMN, because the page has two shapes.
      // With commentary approved the two sit side by side; with it pending
      // the placeholder is a line above the panel and there is no left or
      // right — see `packPrint.css`. These read "The left column…" and "The
      // right column…", which on every pack shipped so far was a sentence
      // describing a layout the sheet did not have.
      note('Commentary', 'This page carries the board\'s own commentary on the period. It prints only once an approver has signed it; until then the page says so rather than printing unapproved text.'),
      note('Action panel', 'The panel headed \'For the board\' is derived from the same checks the matters page tabulates — aged debtor concentration, unreconciled bank items, unusual journals and overdue statutory filings — in the order the matters page prints them: matters with no single rand amount first, then the largest by exposure. It is machine-written and states the decision each matter is waiting on, never a recommendation.'),
    ]),
  ];
}

/** Page 7 — the balance sheet, its composition chart, and the MANDATORY
 *  §3.5 negative-equity disclosure when equity is underwater. */
export function buildPositionBlocks(
  position: PackTable,
  compositionChart: PackChartSpec,
  set: PackFigureSet,
  scale: MoneyScale,
): PackPageBlock[] {
  const positionBlocks: PackPageBlock[] = [
    { kind: 'table', table: position },
    { kind: 'chart', chart: compositionChart },
    commentary(positionCaption(set, scale)),
  ];
  // The asset side FIRST where both apply: negative total assets is the
  // stranger of the two, and it was the one the sheet said nothing about.
  const assets = set.current.totalAssets;
  if (assets < 0) {
    positionBlocks.push(mustDisclose('Negative total assets', [
      note('What this means', negativeAssetsSentence(assets, scale)),
    ]));
  }
  const equity = set.current.totalEquity;
  if (equity < 0) {
    positionBlocks.push(mustDisclose('Negative equity', [
      // One sentence, shared with `NegativeEquityBlock` — a second copy of a
      // MANDATORY §3.5 disclosure is how the two drift apart.
      note('Consequence', negativeEquitySentence(equity, scale)),
    ]));
  }
  return positionBlocks;
}

/** Page 8 — the cash table, the opening→closing bridge (or why there is
 *  none), the closing-cash trend line (or why there is none), and commentary. */
export function buildCashBlocks(
  cash: PackTable,
  cashBridge: PackCashBridge,
  cashTrend: PackChartSpec | null,
  set: PackFigureSet,
  scale: MoneyScale,
): PackPageBlock[] {
  const cashBlocks: PackPageBlock[] = [{ kind: 'table', table: cash }];
  if (cashBridge.drawn) {
    cashBlocks.push({ kind: 'chart', chart: cashBridge.chart });
    // The bridge foots on a named plug, which is honest — but on these
    // figures the plug is larger than the net movement it sits inside, and a
    // bar that dwarfs its own subject needs saying out loud rather than
    // merely labelling. The gate requires this sentence whenever the share
    // breaches; the sentence itself is defined once, beside the check.
    const disproportionate = disproportionatePlugSentence(cashBridge.chart, scale);
    if (disproportionate !== null) {
      cashBlocks.push(mustDisclose('How much of this bridge is unexplained', [
        note('Size of the unexplained step', disproportionate),
      ]));
    }
  }
  else {
    // `why` is written for the reader on `buildCashWaterfallChart`, beside
    // the decision it explains — a second wording here is how the page and
    // the chart come to disagree about what the pack does not have.
    cashBlocks.push(mustDisclose('Movement in cash, and why no bridge is drawn', [
      note('This period', cashBridge.why),
    ]));
  }
  if (cashTrend) cashBlocks.push({ kind: 'chart', chart: cashTrend });
  else {
    cashBlocks.push(mustDisclose('No closing-cash series', [
      note('Why', 'No monthly trend series covers this period, so no closing-cash line can be drawn.'),
    ]));
  }
  cashBlocks.push(disclose('Commentary', [
    note('This period', cashCaption(set, cashBridge.drawn ? cashBridge.residual : null, scale)),
  ]));
  return cashBlocks;
}

/** "a, b and c", or "a" — the same joiner `packTrendCrossReference` uses on
 *  the note beside this one. */
function inWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

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
function scaleNote(panels: TrendPanels): PackDisclosureNote | null {
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
  // own high-to-low range over that span"). Nothing a reader can do with the
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
    const named = inWords(panels.ownScale.map((p) => `${p.name} (${p.sharePct}%)`));
    // WHAT THE PERCENTAGE IS OF, IN THE SENTENCE THAT MAKES THE CLAIM. The
    // page asserted "1.1% of the shared range" and printed nothing a reader
    // could check it against, so a reviewer took the spans off the two
    // figures in each panel's own title — 2 to 29 against 15 to 41 — got
    // near-identical numbers, and reported the two claims as irreconcilable.
    // They are not: the percentage is a panel's whole high-to-low range over
    // the shared span, not the movement between the months its title names.
    // But a share of an unstated number is not a disclosure, whether or not
    // the arithmetic behind it is right.
    //
    // NO SECOND COPY OF THE RANGE. It was stated here as well, because the
    // fitter may take this note and the percentages would then cite an
    // undisclosed denominator. The commentary block above — which the fitter
    // never touches — carries the range, and every panel now prints the ends
    // of its own axis, so the number is on the sheet twice already.
    offShared.push(`${named} (too little range to register on it)`);
  }
  if (panels.ownUnits.length > 0) {
    offShared.push(`${inWords(panels.ownUnits)} (different units)`);
  }
  if (offShared.length > 0) {
    parts.push(`${inWords(offShared)} are on their OWN scales, so their slopes are not comparable `
      + 'with the panels above.');
  }
  // A pack that draws no panel at all has no scale to describe, and a headed
  // note with an empty body is a heading the page cannot honour.
  if (parts.length === 0) return null;
  return note('Scale', parts.join(' '));
}

/** Page 10 — the small multiples (or why none are drawn), commentary, the
 *  shared-scale explanation, and — only when the pack's six panels are not
 *  all drawable — which are missing and why. */
export function buildTrendBlocks(panels: TrendPanels): PackPageBlock[] {
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
  trendBlocks.push(commentary(citesShare
    ? `${trendsCaption(drawn)} The shared y-scale spans ${panels.sharedRange}; a panel's `
      + 'percentage of it is that panel\'s own high-to-low range over that span.'
    : trendsCaption(drawn)));
  // The window note is DERIVED from the panels this page draws — see
  // `trendWindowNote`. Pushed unconditionally, it printed "Gross margin is
  // printed on this page and on the income statement page" two centimetres
  // above a disclosure saying no gross-margin panel could be drawn.
  const windowNote = trendWindowNote(drawn, panels.ratiosEndingOnPartMonth);
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
      note('Why', `A board pack tracks six measures on this page — revenue, gross margin %, operating expenses, net profit, cash and debtor days — and ${drawn.length} of the six could be drawn for this company. A panel is omitted when its figure is not meaningful in every period of the window: gross margin % and debtor days both need positive revenue, and no period here had any. Nothing is inferred in its place.`),
    ]));
  }
  return trendBlocks;
}


/**
 * WHAT THE BRIDGE IS DOING WITH POSITION AND WHAT IT IS DOING WITH COLOUR —
 * because the page stated one rule and drew by two.
 *
 * Sheet 6 prints operating expenses of `226` in the table and `(226)` on the
 * bar six centimetres below it. Both are right and they are not the same
 * quantity: the table states the line as the ledger carries it, and a bridge
 * bar is a STEP — how much that line moved the running total. A cost of 226
 * moves profit by (226).
 *
 * On Brightsphere it reads as an error rather than as a convention:
 * operating expenses are a net CREDIT of (3 717), so the bar is `3 717` and
 * the table `(3 717)`, and the chart appears to state the opposite sign to
 * the table on the same sheet. Nothing on the page said which was which.
 *
 * AND THE SENTENCE THAT SAID IT WAS HALF THE RULE. It read "the bridge draws
 * each line by its EFFECT on net profit", which is true of where a bar is
 * drawn and false of what colour it is: colour keys off the line's CLASS —
 * income green, cost red, in every pack, whichever way the period ran (see
 * `stepColour`). On Brightsphere that produced a green bar pointing DOWN
 * 5 535 and two red bars pointing UP, under a footnote a reader could only
 * read as promising the opposite. Two reviewers have objected to the palette
 * and the class rule has survived both on the merits — a colour that means
 * one thing on a profitable company and another on a distressed one is not
 * carrying meaning — so what was wrong was the sentence. It now states both
 * rules, and names a bar on the page to check each against.
 *
 * DERIVED FROM A BAR THAT ACTUALLY LOOKS WRONG, not printed as boilerplate.
 * Two things make a bar look wrong, and either one puts this note on the
 * page:
 *
 *   1. its bar POINTS the opposite way to the sign of its table cell (Demo's
 *      cost of sales, Brightsphere's operating expenses). The LABEL agrees
 *      with the table — see `WaterfallStep.labelValue`, which is the fix for
 *      the same figure printing with two signs on one sheet — so what is left
 *      to explain is the direction, and that is what this note explains;
 *   2. its ink and its direction disagree — a green bar that points down, a
 *      red one that points up (Brightsphere's revenue).
 *
 * Null when neither happens, because a pack whose bridge nowhere surprises
 * the reader needs no note, and one that printed it anyway would be
 * explaining a contradiction the reader cannot find.
 */
export function bridgeSignFootnote(
  table: PackTable,
  chart: PackChartSpec,
  scale: MoneyScale,
  number: number,
): PackFootnote[] {
  const bars = chart.waterfallBars ?? [];
  const rows = new Map(table.rows.map((row) => [row.label.toLowerCase(), row.figures.actual?.value ?? null]));

  const movements = bars.filter((bar) => bar.kind !== 'subtotal' && bar.kind !== 'open' && bar.kind !== 'close');
  // The sign divergence first, where there is one: it is the harder of the
  // two to read off the page unaided, because it needs the table AND the
  // chart, and it explains the colour case in passing.
  const diverged = movements.find((bar) => {
    const cell = rows.get(bar.label.toLowerCase());
    if (cell === null || cell === undefined || cell === 0) return false;
    const step = bar.end - bar.start;
    return step !== 0 && Math.sign(step) !== Math.sign(cell);
  });
  const contrary = movements.find((bar) => {
    const step = bar.end - bar.start;
    if (step === 0 || bar.paint === undefined) return false;
    return (bar.paint === 'favourable' && step < 0) || (bar.paint === 'unfavourable' && step > 0);
  });
  const named = diverged ?? contrary;
  if (named === undefined) return [];

  const step = named.end - named.start;
  const klass = named.paint === 'favourable' ? 'an income line' : 'a cost line';
  const ink = named.paint === 'favourable' ? 'green' : 'red';
  const moved = step < 0 ? 'reduces' : 'increases';
  const cell = rows.get(named.label.toLowerCase());
  // The example reconciles the TABLE with the bar where the two diverge, and
  // the DIRECTION with the ink where they do not: a reader given the second
  // sentence for a bar whose table cell agrees with it would be sent to
  // check an agreement.
  const example = diverged !== undefined && cell !== null && cell !== undefined
    ? `${named.label} of ${formatMoney(cell, { scale })} in the table is labelled with that same `
      + `figure on the bridge, drawn ${step < 0 ? 'DOWNWARDS' : 'UPWARDS'} because that is the `
      + `direction it ${moved} profit, and in ${ink}, because it is ${klass}. The label and the `
      + 'position are the same fact read two ways.'
    : `${named.label} is drawn in ${ink}, because it is ${klass}, and points `
      + `${step < 0 ? 'DOWN' : 'UP'}, because that is the direction it moved profit this period.`;

  return [{
    number,
    // REQUIRED — see `PackFootnote.required`. This is the only thing on the
    // sheet that reconciles a table cell with the bar drawn from it, and on
    // Brightsphere the fitter took it, leaving a chart that appears to state
    // the opposite sign to the table beside it.
    required: true as const,
    text:
      `The table states each line as the ledger carries it. The bridge below POSITIONS each bar `
      + `by its effect on net profit — up where the line added to it, down where it took away — `
      + `and COLOURS it by what the line is: green for income, red for cost, in every pack and `
      + `whichever way the period ran. ${example}`,
  }];
}
