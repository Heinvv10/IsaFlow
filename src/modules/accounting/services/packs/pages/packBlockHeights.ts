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
/** `max-content` of "Commentary pending approval." at 10pt italic — the one
 *  sentence `.pack-narrative-columns.is-pending` sizes its first column to,
 *  measured at 50.3mm and rounded up. */
const PENDING_PLACEHOLDER_MM = 52;

/** One `.pack-table` body row of a single line, padding and its collapsed
 *  rule included. Rows measure 6.98-7.25mm; the collapsed borders a row's own
 *  box does not report add up to about another millimetre across a table. */
export const TABLE_ROW_MM = 8.15;
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
  const noteLines = disclosure.notes.map((n) =>
    wrappedLines(`${n.heading} ${n.body}`, 9.5, noteMeasureMm(orientation)));
  const total = noteLines.reduce((a, b) => a + b, 0);
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
 * `NarrativeColumns` — the commentary column beside the derived action panel.
 *
 * The two sit side by side in one grid row, so the block costs the TALLER of
 * them, and the measure each is set across depends on which column is which:
 * with commentary approved the panel takes a third of the page; pending, the
 * placeholder shrinks to its own sentence and the panel takes what is left.
 */
export function narrativeMm(narrative: PackNarrative, boardActions: string[], orientation: PageOrientation): number {
  const width = PAGE_WIDTH_MM[orientation];
  const pending = narrative.status === 'pending';
  // 2fr of the grid, against `max-content` on the pending placeholder — one
  // fixed sentence, so a constant of the stylesheet rather than of the data.
  const proseWidth = pending ? PENDING_PLACEHOLDER_MM : (width - GUTTER_MM) * (2 / 3);
  // `.pack-narrative-source` — one line beside the prose, where the measure
  // is two thirds of the page, and two in the panel, where it is a third.
  const source = lines(1, 11);
  const body = pending || narrative.body === null
    ? lines(1, 15)
    : source + lines(wrappedLines(narrative.body, 10, proseWidth), 15);
  const approved = narrative.actions.length === 0 ? 0 : 2 + listMm(narrative.actions, proseWidth - 4);
  const prose = body + approved;

  // The panel's measure: a third of the page beside approved commentary, and
  // everything the placeholder does not want beside a pending one.
  const panelWidth = (pending ? width - GUTTER_MM - PENDING_PLACEHOLDER_MM : (width - GUTTER_MM) / 3) - 4;
  const panel = boardActions.length === 0 ? 0
    : lines(1, 15) + 1 + lines(2, 11) + 1.5 + listMm(boardActions, panelWidth - 8);

  // A pending placeholder with no panel beside it still occupies its grid
  // row: 12.3mm on the paper against the 5.3mm the paragraph itself measures.
  const floor = pending && boardActions.length === 0 ? 12.4 : 0;
  return Math.max(prose, panel, floor);
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
  // The delta prints as a glyph, a percentage and its basis — "▲ up 12.4%
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

