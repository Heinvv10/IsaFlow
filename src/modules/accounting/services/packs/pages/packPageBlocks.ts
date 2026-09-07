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
        ...(comparative === null ? [] : [note('Absent comparatives',
          'A tile with no movement says why in its own caption — the comparative period carries no value for that measure, or its prior figure is not a positive base. A movement is never shown as a move from zero.')]),
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
      note('Commentary', 'The left column carries the board\'s own commentary on the period. It prints only once an approver has signed it; until then this page says so rather than printing unapproved text.'),
      note('Action panel', 'The right column is derived from the same checks the matters page tabulates — aged debtor concentration, unreconciled bank items, unusual journals and overdue statutory filings — in the order the matters page prints them: matters with no single rand amount first, then the largest by exposure. It is machine-written and states the decision each matter is waiting on, never a recommendation.'),
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
    parts.push(
      `${inWords(panels.sharedScale)} share one y-scale, so none of them can look like it moved `
      + 'more than it did.',
    );
  } else if (panels.sharedScale.length === 1) {
    parts.push(`${panels.sharedScale[0]} is the only money panel on the shared y-scale.`);
  }
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
    // A CLAUSE, not a sentence of its own. This page is the tightest in the
    // pack and its notes are the first prose the fitter reaches for; a
    // separate sentence cost 10mm and this costs a line.
    const range = panels.sharedRange === null ? '' : ` (${panels.sharedRange})`;
    parts.push(
      `${named} are drawn on their OWN scales — each has too little of its own range to register `
      + `on the shared one${range}, and says so in its own title. Their slopes are not comparable `
      + 'with the panels above.',
    );
  }
  if (panels.ownUnits.length > 0) {
    parts.push(`${inWords(panels.ownUnits)} are different units and keep their own.`);
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
  const windowNote = trendWindowNote(drawn);
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
 * WHY THE BRIDGE LABELS A LINE THE OPPOSITE WAY THE TABLE DOES.
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
 * DERIVED FROM A ROW THAT ACTUALLY DIVERGES, not printed as boilerplate: the
 * footnote names one line whose bar and cell carry opposite signs, with both
 * figures, so a reader can check the rule against the page in front of them.
 * Null when no line diverges — a pack whose bridge and table agree
 * everywhere needs no note, and one that printed it anyway would be
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
  for (const bar of bars) {
    if (bar.kind === 'subtotal' || bar.kind === 'open' || bar.kind === 'close') continue;
    const cell = rows.get(bar.label.toLowerCase());
    if (cell === null || cell === undefined || cell === 0) continue;
    const step = bar.end - bar.start;
    if (step === 0 || Math.sign(step) === Math.sign(cell)) continue;
    return [{
      number,
      // REQUIRED — see `PackFootnote.required`. This is the only thing on the
      // sheet that reconciles a table cell with the bar drawn from it, and on
      // Brightsphere the fitter took it, leaving a chart that appears to state
      // the opposite sign to the table beside it.
      required: true as const,
      text:
        `The table states each line as the ledger carries it; the bridge below draws each line by `
        + `its EFFECT on net profit. ${bar.label} of ${formatMoney(cell, { scale })} in the table is `
        + `drawn as ${formatMoney(step, { scale })} on the bar — the amount by which it `
        + `${step < 0 ? 'reduces' : 'increases'} profit. The two signs are the same fact read two ways.`,
    }];
  }
  return [];
}
