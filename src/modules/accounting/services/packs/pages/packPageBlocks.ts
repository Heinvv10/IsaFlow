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
  impossibleBalancesSentence,
  negativeEquitySentence,
  tileCaption,
  trendsCaption,
} from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { TRENDS_PANELS_SPECIFIED, type PackCashBridge, type TrendPanels } from './packPageCharts';
import type { SelectedMatters } from './packMattersPrinted';
import { matterSourcesInWords } from './packDerivedMatters';
import { PANEL_OMITTED_RULE } from './packShortenedPanels';
import { trendWindowNote } from './packTrendCrossReference';
import { formatMoney, formatPctLevel, type MoneyScale } from '@/lib/format/money';
import { disproportionatePlugSentence } from '@/modules/accounting/services/packs/figures/packWaterfallIntegrity';
import { ROUNDING_COMPONENTS_NOTE } from './packBasis';
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

export const note = (
  heading: string,
  body: string,
  /** The numbered page footnote this note's claim is qualified by, where it
   *  has one — see `PackDisclosureNote.footnote` and `anchorRow`. */
  footnote?: number,
): PackDisclosureNote => (footnote === undefined ? { heading, body } : { heading, body, footnote });

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

/**
 * THE LINES THAT COVER LESS OF THE WINDOW THAN THE ONES BESIDE THEM.
 *
 * Page 3's sparklines are drawn to one width, side by side. Gross margin and
 * debtor days have no meaningful figure in a month with no revenue, so those
 * months are dropped rather than plotted as a false zero — on the live demo
 * company that is nine of twelve, three points against the other lines'
 * twelve, at the same width and with nothing on the sheet saying so. A
 * reader compares the shapes, which is the only thing a sparkline is for.
 *
 * Grouped by the window they actually cover rather than listed one by one:
 * the two short lines are short for the same reason and by the same amount,
 * and one clause per tile is three lines of 9.5pt on a sheet that has none
 * spare. Empty where every line covers the whole window, which is the usual
 * case and must cost the sheet nothing.
 */
function shortWindowClause(tiles: PackKpiTile[]): string {
  const short = tiles.filter((t) => t.sparklineWindow !== null && t.sparklineWindow.plotted < t.sparklineWindow.of);
  if (short.length === 0) return '';
  const groups = new Map<string, string[]>();
  for (const tile of short) {
    const window = tile.sparklineWindow!;
    const key = `${window.plotted} of the window's ${window.of} months`;
    groups.set(key, [...(groups.get(key) ?? []), tile.label]);
  }
  const clauses = [...groups].map(([window, labels]) => `${inWords(labels)} plot ${window}`);
  return ` ${inWords(clauses)}: a month with no meaningful figure is dropped rather than drawn as zero, `
    + 'so lines of the same width do not all cover the same months.';
}

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
        // AND IT NAMES THE BLOCK THE REASON IS ACTUALLY IN. It read "in its
        // own caption above" — a tile has no caption; the reasons are the
        // Commentary block's lines, one per tile, three centimetres up the
        // sheet. A reader who looks where a note sends them and finds nothing
        // stops trusting the note.
        ...(comparative === null ? [] : [note('Absent comparatives',
          'A tile with no movement says why in its line of the Commentary above. A movement is never shown as a move from zero.')]),
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
        // THE COMPONENTS HALF, like the statement footnotes — see
        // `ROUNDING_FOOTNOTES`. The ratio clause matters most on this sheet,
        // whose headline tile is the gross margin a reader cannot reproduce
        // from the figures beside it, and Brightsphere's sheet 3 composes at
        // 98.7% of its box: carried here it drops the part-month note this
        // page states two lines above. Page 12 carries both halves.
        note('Scale', `Figures are in ${scale} (${currency}). ${ROUNDING_COMPONENTS_NOTE}`),
      ]),
    ],
    // AND THE SPARKLINE IS A DIFFERENT WINDOW FROM THE TILE IT SITS IN.
    // The figure is the whole reporting period; the line beside it is a month
    // at a time, which is the same month-versus-period divergence the trends
    // page carries its own note about — see `trendWindowNote`.
    //
    // AND THE LINES ARE NOT ALL THE SAME WINDOW AS EACH OTHER, which is the
    // half this note used to leave out: `shortWindowClause`. It is paid for
    // out of this note's own restatement — "and show none rather than a line
    // drawn from a single point" said again what the clause before it says,
    // and sheet 3 composes at 98.7% of its box on Brightsphere, so a new
    // sentence has to displace an old one or the sheet prints an apology for
    // its layout instead.
    footnotes: [{
      number: SPARKLINE_FOOTNOTE,
      text: "Each tile's figure covers the WHOLE reporting period; the sparkline beside it runs over the monthly "
        + `trend series, a different window. ${sparklineCount} of ${highlightTiles.length} tiles carry one; the rest `
        + `have no monthly series behind them.${shortWindowClause(highlightTiles)}`,
    }],
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
      // THE LIST IS RENDERED, NOT TYPED. It named four checks and the panel
      // three lines below it carried a matter none of the four produces —
      // the net-credit month, which is the LARGEST exposure in both packs
      // and the one this page's own headline names. See `MATTER_SOURCES`.
      note('Action panel', `The panel headed 'For the board' is derived from the same checks the matters page tabulates — ${matterSourcesInWords()} — in the order the matters page prints them: matters with no single rand amount first, then the largest by exposure. It is machine-written and states the decision each matter is waiting on, never a recommendation.`),
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
  // THE SIGN CHECK, OVER EVERY ASSET AND LIABILITY LINE THIS PAGE PRINTS.
  //
  // It ran on TOTAL assets and on COMPONENT liabilities and on nothing else,
  // which is what let Brightsphere print `Non-current liabilities (424)` with
  // a headed block beside it and `Current assets (3 372)` three rows above
  // with none: that pack's total assets are positive, and the asset check
  // only ever looked at the total. Symmetric now — both sides, both levels —
  // read off the table the page prints, so it can only name a row the sheet
  // shows and states that row's own label.
  //
  // Equity is not in it. Negative equity is a real position a real business
  // can hold; it has its own §3.5 disclosure below, and folding it in here
  // would tell a director that insolvency is a posting error.
  const impossible = position.rows
    .filter((row) => /assets$|liabilities$/i.test(row.label))
    .map((row) => ({ label: row.label, amount: row.figures.actual?.value ?? 0 }))
    .filter((line) => line.amount < 0);
  if (impossible.length > 0) {
    const hasAssets = impossible.some((l) => /assets$/i.test(l.label));
    const hasLiabilities = impossible.some((l) => /liabilities$/i.test(l.label));
    positionBlocks.push(mustDisclose('Balances below zero', [
      note('What this means', impossibleBalancesSentence(
        impossible,
        hasAssets && hasLiabilities ? 'both' : (hasAssets ? 'assets' : 'liabilities'),
        scale,
      )),
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
    const named = inWords(panels.ownScale.map((p) => `${p.name} (${formatPctLevel(p.sharePct)})`));
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
    offShared.push(`${named} (too little of it to register)`);
  }
  if (panels.ownUnits.length > 0) {
    offShared.push(`${inWords(panels.ownUnits)} (different units)`);
  }
  if (offShared.length > 0) {
    // "the panels above", not "the SHARED-SCALE panels", was a position on
    // the sheet rather than the class it means — and the top-right panel has
    // nothing above it, so for that one the caution named nothing. The
    // panels are laid out two across in an order the data decides, so any
    // wording that points by position is wrong on some company.
    parts.push(`${inWords(offShared)} are on their OWN scales, so their slopes are not comparable `
      + 'with the shared-scale panels.');
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
      note('Why', `A board pack tracks six measures on this page — revenue, gross margin %, operating expenses, net profit, cash and debtor days — and ${drawn.length} of the six could be drawn for this company. ${PANEL_OMITTED_RULE}: gross margin % and debtor days both need positive revenue, and no period here had any. Nothing is inferred in its place.`),
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
): { footnotes: PackFootnote[]; anchor: string | null } {
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
  // WHAT THE BRIDGE LEFT OUT, which is a statement about the drawing whether
  // or not there is a sign to reconcile — see `PackChartSpec.omittedBars`.
  const omitted = chart.omittedBars ?? [];
  const omission = omitted.length === 0
    ? ''
    : ` A line with a nil figure for the period is not drawn: ${inWords(omitted)}.`;
  // NO EXEMPLAR, NO SIGN SENTENCE — and therefore no anchor either. The
  // caller reads `anchor` to put the superscript on the row this sentence is
  // about, which is why the label is returned rather than only printed: a
  // footnote naming Cost of sales and marking nothing is the unanchored
  // series this whole round is removing. The omission sentence is not about
  // a row, so it stands on its own where there is nothing to reconcile.
  if (named === undefined) {
    return omission === ''
      ? { footnotes: [], anchor: null }
      : { anchor: null, footnotes: [{ number, required: true as const, text: omission.trim() }] };
  }

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

  return { anchor: named.label, footnotes: [{
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
      + `whichever way the period ran. ${example}${omission}`,
  }] };
}
