/**
 * HOW TALL ONE BLOCK'S CONTENT IS — the per-kind arithmetic behind
 * `blockMm`, split from `packPageMetrics.ts` at the 300-line cap.
 *
 * The seam is the one the model already has: this file knows what a
 * disclosure, a tile, a table and a narrative column are made of, and
 * `packPageMetrics.ts` knows what a PAGE is made of. Every constant here is
 * transcribed from `styles/packPrint.css` and re-measured against Chromium's
 * own layout by `packSheetCount.test.ts`.
 */
import { lines, PAGE_WIDTH_MM, PT_MM, wrappedLines, type PageOrientation } from './packTextMetrics';
import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackDisclosure, PackNarrative, PackPageBlock } from './packPageModel';

/** `--pack-gutter`. */
export const GUTTER_MM = 8;
/**
 * `.pack-narrative-columns.is-pending .pack-narrative-actions`'s measure —
 * the FULL page width now, which is what removed the dead column beside it.
 *
 * It was 120mm, kept on the argument that "9.5pt across the full 174mm is
 * about a hundred characters to the line". The argument does not survive
 * being applied to the rest of the document: `.pack-disclosure-body` is the
 * SAME 9.5pt over the SAME 14pt leading and runs the full 174mm on every
 * disclosure in the pack, including the three directly beneath this panel on
 * page 4. The panel was the one 9.5pt block in twelve sheets set to a
 * different measure, and the 54mm it left carried 0.70% ink on the demo and
 * 0.95% on Brightsphere — a band that reads as the unfilled second column of
 * a two-column layout, on the first thing a chair reads.
 *
 * It also makes the page SHORTER rather than longer, which is why it is safe
 * on a sheet with 4.01mm of slack: the five action items wrap to 14 lines at
 * 120mm and 10 at the full measure. 155mm reaches 10 too, and leaves 19mm of
 * band; there is no line to be bought by stopping short of the measure every
 * other block on the sheet uses.
 */
const PENDING_PANEL_MM = PAGE_WIDTH_MM.portrait;
/** The `row-gap` between the placeholder and the panel below it. */
const PENDING_ROW_GAP_MM = 2;

/** One `.pack-table` body row of a single line, padding and its collapsed
 *  rule included. Rows measure 6.98-7.25mm; the collapsed borders a row's own
 *  box does not report add up to about another millimetre across a table. */
export const TABLE_ROW_MM = 8.15;
/**
 * ONE ROW OF EBITDA'S RECONCILIATION BRIDGE — the `.pack-table` inside a
 * glossary entry, which carries no rules and must not be charged for any.
 *
 * It was charged `TABLE_ROW_MM`, and the millimetre of difference deleted five
 * facts from the one page that exists to state them. `.pack-table` is 9pt over
 * a 13pt leading (4.586mm) with `td { padding: 1.2mm 2mm }` either side, so a
 * row with no border is 6.99mm; `TABLE_ROW_MM` is a sixth of a millimetre more
 * than that per row because a STATEMENT's rows carry subtotal, total and
 * grand-total rules whose collapsed borders a row's own box does not report.
 * The bridge has three plain `<tr>`s and no rule on any of them.
 *
 * Three rows at the statement's price over-charged page 12 by 3.5mm on a page
 * the browser lays out at 253.8mm in a 255mm box. The fitter, believing the
 * model, took `Currency and rounding`, `Source system`, `Rounding`,
 * `Extracted at` and `Ledger version` off the basis of preparation to pay for
 * millimetres that were never on the paper.
 *
 * Chromium measured the bridge growing by 7.0, 7.0 and 6.9mm across its three
 * rows at `.pack-table td`'s 1.2mm padding. `.pack-definition-bridge td` sets
 * 0.6mm — a three-line bridge inside a glossary entry does not want a
 * statement's row rhythm, and the comparative column added by the
 * two-column bridge has to be paid for on a page that fits with millimetres
 * to spare. 5.9 is 7.0 less the 1.2mm of padding taken off, rounded up;
 * `packSheetCount.test.ts` re-measures it against the browser.
 */
export const DEFINITION_BRIDGE_ROW_MM = 5.9;
/** The comparative column's heading row on that bridge. A `.pack-table th` at
 *  8pt over a 12pt line, with `.pack-definition-bridge th`'s 0.4mm padding
 *  rather than the statement header's 1.5mm — see `styles/packPrint.css`.
 *  Charged at `TABLE_HEAD_MM` it read 8 and cost page 12 three millimetres it
 *  does not have. */
export const DEFINITION_BRIDGE_HEAD_MM = 4.9;
/** A `.pack-table` header row. The statements' and the scorecard's column
 *  headings are a fixed enum of short labels and measure 7.4mm on every
 *  fixture; the matters table's "Quantum (R\'000)" wraps, and is budgeted at
 *  the two lines it takes there. */
export const TABLE_HEAD_MM = 8;
/** A `.pack-scorecard-group` row and header. Measured at 7.25mm and 7.36mm on
 *  every fixture — the group tables carry no subtotal or grand-total rules,
 *  which is what makes a statement row a millimetre dearer. */
export const SCORECARD_ROW_MM = 7.45;
export const SCORECARD_HEAD_MM = 7.6;
/**
 * `.pack-matters-omitted` — the two 7.5pt lines under the table that state
 * how many matters did not fit and what they come to.
 *
 * Exported because page 11's budget has to RESERVE it: the budget is taken
 * with an empty table, and the moment the selection leaves a matter out the
 * block grows this note. Spent without reserving it, the page overshoots by
 * exactly this much and the trimmer takes a disclosure to pay for it.
 */
export const MATTERS_OMITTED_NOTE_MM = 1.5 + 2 * 11 * PT_MM;

/**
 * `.pack-table-notes` — the not-meaningful reasons printed once under a table
 * rather than in every cell they apply to.
 *
 * The distinct-reason walk is `collectReasons`'s, repeated rather than
 * imported: that function lives in a component, and a service reaching into
 * the render layer to measure paper would put a layout decision on the wrong
 * side of the boundary. Same trade `printedProseKeys` makes, held together
 * the same way — by the measurement test, on the printed sheet.
 */
export function notMeaningfulNotesMm(figures: Array<PackFigure | null | undefined>, widthMm: number): number {
  const reasons: string[] = [];
  for (const figure of figures) {
    if (figure === undefined || figure === null || figure.value !== null) continue;
    const reason = figure.unavailable;
    if (reason !== undefined && reason !== null && !reasons.includes(reason)) reasons.push(reason);
  }
  if (reasons.length === 0) return 0;
  return 1.5 + lines(
    reasons.reduce((sum, r) => sum + wrappedLines(r, 7.5, widthMm - 6), 0),
    11,
  );
}

/** The measure a disclosure note is set across — the full page in portrait,
 *  one of two columns in landscape. */
function noteMeasureMm(orientation: PageOrientation): number {
  if (orientation === 'portrait') return PAGE_WIDTH_MM.portrait;
  // A landscape column is 126.4mm. It is budgeted at 116: the column-balancer
  // below turns one extra line into half a line of page, and half a line is
  // the difference between the trends page fitting and not.
  return 116;
}

/** `.pack-disclosure` — a 15pt heading, then one 14pt paragraph per note. */
export function disclosureMm(disclosure: PackDisclosure, orientation: PageOrientation): number {
  const heading = lines(wrappedLines(disclosure.heading, 11, PAGE_WIDTH_MM[orientation]), 15);
  const twoColumn = disclosure.columns === 2 && orientation === 'portrait';
  const measure = twoColumn ? (PAGE_WIDTH_MM.portrait - GUTTER_MM) / 2 : noteMeasureMm(orientation);
  // The list variant is set at the glossary's 8.5pt (see `packPrint.css`); a
  // disclosure that is an ARGUMENT keeps the pack's 9.5pt prose size.
  const notePt = twoColumn ? 8.5 : 9.5;
  const noteLines = disclosure.notes.map((n) => wrappedLines(`${n.heading} ${n.body}`, notePt, measure));
  const total = noteLines.reduce((a, b) => a + b, 0);
  if (twoColumn) {
    // Each note is `break-inside: avoid`, so the block is the taller of the
    // two columns under Chromium's own in-order balance — the same model
    // `blockMm` uses for the glossary, and for the same reason.
    //
    // PLUS ONE LINE, WHICH IS THE BALANCER'S OWN SLACK AND NOT A FUDGE.
    // `balancedLines` is the BEST in-order split; Chromium's multicol
    // balancer does not always find it. Measured on the basis page's own
    // block against the real faces: at eight notes and at six it lays the
    // taller column out one line above the best split, and at seven, five,
    // four and three it hits the split exactly. One line is that error, and
    // `packSheetCount.test.ts` re-measures it on every fixture.
    //
    // This used to be paid for by charging `(notes - 1) * 1.5` for the gap
    // between notes, which covered the balancer by accident and cost the
    // block ten millimetres for eight one-line facts. The gap is now zero in
    // `packPrint.css` — a list of label-and-value pairs on a 14pt leading is
    // separated already — and the balancer is paid for on purpose.
    return heading + 1.5 + lines(balancedLines(noteLines) + 1, 12);
  }
  if (orientation === 'portrait') return heading + disclosure.notes.length * 1.5 + lines(total, 14);
  // Landscape sets the notes in two balanced columns (`column-count: 2`) and
  // the block is as tall as the taller one. Chromium balances by LINE across
  // the whole block, so the height is half the lines — floored at two,
  // because a two-line note is the one shape that cannot split (each column
  // would keep a single line, which `widows`/`orphans` refuse). The gaps ride
  // in the taller column, the pessimistic reading of where they land.
  const balanced = Math.max(2, Math.ceil(total / 2));
  return heading + 1.5 + lines(balanced, 14) + Math.max(0, disclosure.notes.length - 1) * 1.5;
}

/**
 * `NarrativeColumns` — the commentary and the derived action panel.
 *
 * TWO SHAPES, AND THE STATUS DECIDES WHICH. With commentary approved the two
 * sit side by side in one grid row, so the block costs the TALLER of them and
 * the panel is set across a third of the page. With commentary PENDING there
 * is no commentary column at all: the placeholder is a line above the panel
 * and the block costs both, one after the other. See `packPrint.css` for why
 * a one-line column beside a five-paragraph one had to stop.
 */
export function narrativeMm(
  narrative: PackNarrative,
  boardActions: string[],
  orientation: PageOrientation,
  /** The counts under the panel — see `boardActionsTail`. 7.5pt over 11,
   *  the pack's footnote setting, and charged because the renderer draws
   *  them: a block whose renderer prints something this does not measure is
   *  how the three overflows `packTextMetrics` exists for happened. */
  boardActionsTail: string[] = [],
  /**
   * Whether this block is drawn in the ONE-COLUMN shape — see
   * `PackPageBlock`'s `stackActions` and `stackNarrativeActions` below.
   *
   * The flag is the BLOCK's rather than this function's opinion, because
   * `NarrativeColumns` has to draw whichever layout was measured: a page
   * measured stacked and drawn in columns is a page over its sheet with
   * nothing on it to say so.
   */
  stackActions = false,
): number {
  const width = PAGE_WIDTH_MM[orientation];
  const pending = narrative.status === 'pending';
  // `.pack-narrative-source` — one line beside the prose, where the measure
  // is two thirds of the page, and two in the panel, where it is a third.
  const source = lines(1, 11);
  const tailOf = (widthMm: number): number => (boardActionsTail.length === 0 ? 0
    : 2 + lines(wrappedLines(boardActionsTail.join(' '), 7.5, widthMm), 11));
  const panelOf = (widthMm: number): number => (boardActions.length === 0 ? 0
    : lines(1, 15) + 1 + lines(2, 11) + 1.5 + listMm(boardActions, widthMm - 8) + tailOf(widthMm - 8));

  if (pending) {
    const placeholder = lines(1, 15);
    const panel = panelOf(PENDING_PANEL_MM - 4);
    // A placeholder with no panel under it still occupies its grid row:
    // 12.3mm on the paper against the 5.3mm the paragraph itself measures.
    if (panel === 0) return 12.4;
    return placeholder + PENDING_ROW_GAP_MM + panel;
  }

  /** The prose column and the approver's own action list, at a given measure. */
  const proseOf = (widthMm: number): number => {
    const body = narrative.body === null
      ? lines(1, 15)
      : source + lines(wrappedLines(narrative.body, 10, widthMm), 15);
    return body + (narrative.actions.length === 0 ? 0 : 2 + listMm(narrative.actions, widthMm - 4));
  };

  // STACKED: the prose over the panel, both at the full measure — the same
  // one-column shape `is-pending` draws for this same panel.
  if (stackActions && boardActions.length > 0) {
    return proseOf(width) + PENDING_ROW_GAP_MM + panelOf(PENDING_PANEL_MM - 4);
  }
  // SIDE BY SIDE: `2fr 1fr`, so the row costs the taller of its two columns.
  // The prose is charged at two thirds of the measure even where there is no
  // panel beside it and `is-single` gives it all of it — generous by a few
  // lines on the four sheets carrying a derived caption, and generous is the
  // direction that cannot spill a page.
  return Math.max(proseOf((width - GUTTER_MM) * (2 / 3)), panelOf((width - GUTTER_MM) / 3 - 4));
}

/** A `<ul>` of prose items, each wrapped to `widthMm`, 1.5mm apart. */
function listMm(items: string[], widthMm: number): number {
  return items.reduce((sum, item, i) =>
    sum + (i === 0 ? 0 : 1.5) + lines(wrappedLines(item, 9.5, widthMm), 14), 0);
}

type KpiTile = (PackPageBlock & { kind: 'kpiTiles' })['tiles'][number];

/** The measure a tile's own text is set across. `repeat(4, 1fr)` with a
 *  `nowrap` figure lets one column pull wider than a quarter and the rest
 *  narrower; 33mm is under every column measured, which is the direction that
 *  over-counts lines rather than under-counting them. */
const KPI_COLUMN_MM = 36;
/** The sparkline is `width: 100%; height: auto` — its height follows its
 *  column, at 0.8 of the width across every column the fixtures produce. */
const KPI_SPARKLINE_MM = 33;

export function kpiTileHeight(tile: KpiTile): number {
  const label = lines(wrappedLines(tile.label, 9, KPI_COLUMN_MM), 12);
  const figure = tile.figure.value === null
    ? lines(wrappedLines(tile.figure.unavailable ?? '', 11, KPI_COLUMN_MM), 14)
    : lines(1, 25);
  // The delta prints as a glyph, a percentage and its basis — "↑ up 12.4%
  // against prior period". The words around the basis are the widest the
  // formatter emits.
  const delta = tile.delta === null ? 0
    : 1 + lines(wrappedLines(`X up 00.0% ${tile.delta.basis}`, 9, KPI_COLUMN_MM), 12);
  const spark = tile.sparklineSvg === null ? 0 : 1 + KPI_SPARKLINE_MM;
  return label + 1 + figure + delta + spark;
}

/** `.pack-table` — an 8pt header row over 9pt body rows, with the reasons
 *  list underneath. Only the label column wraps. */
export function tableMm(
  rowLabels: string[],
  figures: Array<PackFigure | null | undefined>,
  widthMm: number,
  labelShare: number,
  rowMm: number = TABLE_ROW_MM,
  headMm: number = TABLE_HEAD_MM,
): number {
  const body = rowLabels.reduce(
    (sum, label) => sum + wrappedLines(label, 9, widthMm * labelShare) * rowMm, 0);
  return headMm + body + notMeaningfulNotesMm(figures, widthMm);
}



/**
 * The taller of two balanced columns of unbreakable items, in the items' own
 * units.
 *
 * Chromium balances a `column-count: 2` block by finding the SMALLEST height
 * at which a greedy top-to-bottom fill still fits in two columns; with
 * `break-inside: avoid` on every item, that is exactly the best in-order
 * split. Modelled rather than approximated: a `total / 2` reads short by up
 * to a whole item, and `total / 2 + the tallest item` — the safe fudge — cost
 * page 12 forty millimetres it did not have.
 *
 * @param gap The space BETWEEN two items in the same column, in the items'
 *   own units — `.pack-definition + .pack-definition`'s 2mm, and zero for a
 *   list that has none.
 *
 *   It is charged per COLUMN, not per item, because the item that starts the
 *   second column does not print it: a `margin-top` at the top of a
 *   fragmentainer is truncated, and Chromium truncates this one. Baking it
 *   into every item but the first — which is what the caller used to do —
 *   therefore charges one gap that never reaches paper. Two millimetres,
 *   measured: the live demo company's glossary lays out at 155.7mm under the
 *   print harness against 157.7mm of estimate, and page 12 was 0.67mm over
 *   its box, so those two millimetres were costing the sheet FOUR of its
 *   eight provenance facts.
 */
export function balancedLines(items: number[], gap = 0): number {
  const total = items.reduce((a, b) => a + b, 0);
  let best = Infinity;
  let head = 0;
  for (let i = 0; i < items.length; i += 1) {
    head += items[i]!;
    // Items 0..i in the first column, the rest in the second; each column
    // pays for the gaps BETWEEN its own items and none above its first.
    const first = head + i * gap;
    const second = (total - head) + Math.max(0, items.length - i - 2) * gap;
    best = Math.min(best, Math.max(first, second));
  }
  return best;
}
