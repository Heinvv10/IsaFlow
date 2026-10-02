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
import { GUTTER_MM } from './packDisclosureHeight';
import type { PackNarrative } from './packPageModel';

/** The disclosure's arithmetic and the KPI tile's split to
 *  `packDisclosureHeight.ts` and `packKpiTileHeight.ts` for the 300-line cap.
 *  Re-exported because every existing caller imports them here. */
export { GUTTER_MM };
export { disclosureMm, balancedLines } from './packDisclosureHeight';
export { kpiTileHeight } from './packKpiTileHeight';

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

