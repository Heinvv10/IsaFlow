/**
 * HOW TALL A PAGE WILL BE, IN MILLIMETRES, BEFORE IT IS PRINTED.
 *
 * `selectPrintedMatters` already had a line budget, because the matters
 * table was the block that overflowed the sheet the day someone looked. Then
 * the scorecard's cross-reference footnote overflowed, and put two lines of
 * grey 7.5pt on a sheet of its own with no title, in the middle of a pack
 * whose contents page indexes twelve items and whose footers count thirteen.
 * Then the trends page's "Panels not drawn" block overflowed, on a different
 * company, for the same reason. Three overflows, three blocks, one cause: a
 * budget that covered ONE of the things that grows with data.
 *
 * A fixture derived from one failure is shaped like that failure, and the
 * next overflow comes from whatever the fixture did not copy. So this file
 * does not model the block that overflowed last — it models EVERY block the
 * pack can put on a page, so `fitPageToBox` can decline to compose a page
 * that does not fit rather than leaving a browser to discover it.
 *
 * THE CONTRACT IS THAT IT NEVER UNDER-ESTIMATES. A model that is sometimes
 * low is a model that sometimes ships a thirteenth sheet, so every constant
 * below sits on the pessimistic side of what was measured, and
 * `packPageMetrics.test.ts` re-measures all of them — block by block, page by
 * page — against Chromium's own layout on every fixture the print harness
 * carries. An over-estimate costs a note that would have fitted; an
 * under-estimate costs the twelve-sheet contract. They are not symmetrical.
 *
 * NOTHING HERE READS THE DOM, and it cannot: the composer runs server-side,
 * before any browser sees the document. It reads `styles/packPrint.css`'s own
 * type scale, transcribed. A CSS change that moves a line-height moves this
 * file too — which is what the measurement test exists to force.
 */
import { PDF_MARGIN_MM } from '@/lib/pdf/pdfTransport';
import type { PackFigure } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type {
  PackDisclosure,
  PackNarrative,
  PackPage,
  PackPageBlock,
} from './packPageModel';
import { mattersTableMm } from './packMattersPrinted';

const PT_MM = 25.4 / 72;

/** The box one sheet gives a page, and the measure its text is set across —
 *  A4 in both orientations, less the margins the transports pass. The same
 *  arithmetic `.pack-page`'s `min-height` states in CSS, off the same single
 *  source of truth for the margin. */
export const PAGE_BOX_MM = {
  portrait: 297 - PDF_MARGIN_MM.top - PDF_MARGIN_MM.bottom,
  landscape: 210 - PDF_MARGIN_MM.top - PDF_MARGIN_MM.bottom,
} as const;

export const PAGE_WIDTH_MM = {
  portrait: 210 - PDF_MARGIN_MM.left - PDF_MARGIN_MM.right,
  landscape: 297 - PDF_MARGIN_MM.left - PDF_MARGIN_MM.right,
} as const;

export type PageOrientation = keyof typeof PAGE_BOX_MM;

/** A page as this file needs it — the number is assigned last, and the paper
 *  a page takes does not depend on it. */
export type MeasurablePage = Omit<PackPage, 'number'>;

/**
 * HOW WIDE A CHARACTER OF IBM PLEX SANS IS, in ems of the type size.
 *
 * NOT one average, and that is the correction that mattered. A single mean —
 * 0.437em across the pack's ordinary prose — under-counts every string the
 * pack builds out of identifiers: page 4's action panel carries check
 * failures naming a company UUID, and a run of digits is a third wider than
 * the letters the mean was taken over. The model called those items three
 * lines and Chromium set four, which is the direction that ships a
 * thirteenth sheet. Page titles carry figures for the same reason.
 *
 * The classes are coarse on purpose: this is a budget, not a shaper, and
 * `packPageMetrics.test.ts` re-measures the result against Chromium on every
 * fixture rather than trusting the table.
 */
const EM_SPACE = 0.26;
const EM_NARROW = 0.34;
const EM_DIGIT = 0.62;
const EM_UPPER = 0.68;
const EM_WIDE = 0.84;
const EM_DEFAULT = 0.47;
/** Narrow glyphs: the letters set on a thin advance, and most punctuation. */
const NARROW = new Set([...'ijltfr.,;:\'"!|()[]{}-–…/']);
/** The two letters set wider than an en — `m` and `w`, and their capitals. */
const WIDE = new Set([...'mwMW']);

/** How wide one character is, in ems. */
function charEms(ch: string): number {
  if (ch === ' ') return EM_SPACE;
  if (WIDE.has(ch)) return EM_WIDE;
  if (NARROW.has(ch)) return EM_NARROW;
  if (ch >= '0' && ch <= '9') return EM_DIGIT;
  if (ch >= 'A' && ch <= 'Z') return EM_UPPER;
  return EM_DEFAULT;
}

/** How wide a string is, in ems. */
function textEms(text: string): number {
  let ems = 0;
  for (const ch of text) ems += charEms(ch);
  return ems;
}

/**
 * The safety factor on every measure.
 *
 * Eight per cent, and no more, because it is paid on every line of every page:
 * the accuracy is meant to come from the em table above and from wrapping on
 * WORDS, not from a fudge large enough to hide a modelling error. What it
 * covers is kerning and the semibold face a note's own lead-in is set in.
 */
const WIDTH_SAFETY = 1.08;

/** `--pack-baseline`: the gap between two blocks. */
export const BLOCK_GAP_MM = 4.5;
/** `--pack-gutter`. */
const GUTTER_MM = 8;
/** `max-content` of "Commentary pending approval." at 10pt italic — the one
 *  sentence `.pack-narrative-columns.is-pending` sizes its first column to,
 *  measured at 50.3mm and rounded up. */
const PENDING_PLACEHOLDER_MM = 52;

/** One `.pack-table` body row of a single line, padding and its collapsed
 *  rule included. Rows measure 6.98-7.25mm; the collapsed borders a row's own
 *  box does not report add up to about another millimetre across a table. */
const TABLE_ROW_MM = 8.15;
/** A `.pack-table` header row. The statements' and the scorecard's column
 *  headings are a fixed enum of short labels and measure 7.4mm on every
 *  fixture; the matters table's "Quantum (R\'000)" wraps, and is budgeted at
 *  the two lines it takes there. */
const TABLE_HEAD_MM = 8;
/** A `.pack-scorecard-group` row and header. Measured at 7.25mm and 7.36mm on
 *  every fixture — the group tables carry no subtotal or grand-total rules,
 *  which is what makes a statement row a millimetre dearer. */
const SCORECARD_ROW_MM = 7.45;
const SCORECARD_HEAD_MM = 7.6;
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

/** The ems of `pt`-sized text one `widthMm` line holds. */
function emsPerLine(pt: number, widthMm: number): number {
  return (widthMm / (pt * PT_MM)) / WIDTH_SAFETY;
}

/**
 * Lines a string takes at `pt` across `widthMm`. At least one — an empty
 * paragraph still occupies its line box.
 *
 * WORD BY WORD, not a division. A character count assumes text breaks
 * anywhere, and the pack's does not: an unbreakable 36-character identifier
 * pushes the line before it short, and the division cannot see it.
 */
export function wrappedLines(text: string, pt: number, widthMm: number): number {
  return wrapEms(text, emsPerLine(pt, widthMm));
}

/**
 * The same greedy wrap against a measure stated in CHARACTERS of ordinary
 * prose — which is how `packMattersPrinted` divides its five columns. One
 * character is `EM_DEFAULT` wide by definition here, so the two models share
 * a wrapper rather than a constant.
 */
export function linesForChars(text: string, perLine: number): number {
  return wrapEms(text, perLine * EM_DEFAULT);
}

function wrapEms(text: string, perLine: number): number {
  let count = 1;
  let used = 0;
  for (const word of text.split(/\s+/)) {
    if (word.length === 0) continue;
    const wordEms = textEms(word);
    const withWord = used === 0 ? wordEms : used + EM_SPACE + wordEms;
    if (withWord <= perLine) { used = withWord; continue; }
    if (used > 0) count += 1;
    used = wordEms;
    // A word wider than the measure breaks inside itself.
    while (used > perLine) { count += 1; used -= perLine; }
  }
  return count;
}

/** Millimetres of `n` lines set at a `lineHeightPt` leading. */
function lines(n: number, lineHeightPt: number): number {
  return n * lineHeightPt * PT_MM;
}

/**
 * `.pack-table-notes` — the not-meaningful reasons printed once under a table
 * rather than in every cell they apply to.
 *
 * The distinct-reason walk is `collectReasons`'s, repeated rather than
 * imported: that function lives in a component, and a service reaching across
 * into the render layer to measure paper would put a layout decision on the
 * wrong side of the boundary. Same trade `printedProseKeys` makes in
 * `packMattersPrinted.ts`, held together the same way — by the measurement
 * test, on the printed sheet.
 */
function notMeaningfulNotesMm(figures: Array<PackFigure | null | undefined>, widthMm: number): number {
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

/** `.pack-disclosure` — a 15pt heading, then one 14pt-leaded paragraph per
 *  note with a 1.5mm gap above each. */
function disclosureMm(disclosure: PackDisclosure, orientation: PageOrientation): number {
  const heading = lines(wrappedLines(disclosure.heading, 11, PAGE_WIDTH_MM[orientation]), 15);
  const noteLines = disclosure.notes.map((n) =>
    wrappedLines(`${n.heading} ${n.body}`, 9.5, noteMeasureMm(orientation)));
  const total = noteLines.reduce((a, b) => a + b, 0);
  if (orientation === 'portrait') return heading + disclosure.notes.length * 1.5 + lines(total, 14);
  // Landscape sets the notes in two balanced columns (`column-count: 2`), and
  // the block is as tall as the taller column. Chromium balances by LINE
  // across the whole block, so the height is half the lines — with a floor of
  // two, because a two-line note is the one shape that does not split (each
  // column would be left with a single line, which `widows`/`orphans` refuse)
  // and it is the commonest note on the trends page. The gaps ride in the
  // taller column, which is the pessimistic reading of where they land.
  const balanced = Math.max(2, Math.ceil(total / 2));
  return heading + 1.5 + lines(balanced, 14) + Math.max(0, disclosure.notes.length - 1) * 1.5;
}

/**
 * `NarrativeColumns` — the commentary column beside the derived action panel.
 *
 * The two sit side by side in one grid row, so the block costs the TALLER of
 * them, and the measure each is set across depends on which column is which:
 * with commentary approved the panel takes a third of the page, and with it
 * pending the placeholder shrinks to its own sentence and the panel takes
 * what is left. Both cases are modelled, because the pack prints the pending
 * one on every company today and the approved one is what it is built for.
 */
function narrativeMm(narrative: PackNarrative, boardActions: string[], orientation: PageOrientation): number {
  const width = PAGE_WIDTH_MM[orientation];
  const pending = narrative.status === 'pending';
  // 2fr of the grid, against `max-content` on the pending placeholder — which
  // is one fixed sentence, so its measure is a constant of the stylesheet
  // rather than of the data.
  const proseWidth = pending ? PENDING_PLACEHOLDER_MM : (width - GUTTER_MM) * (2 / 3);
  // `.pack-narrative-source` — one line beside the prose, where the measure
  // is two thirds of the page, and two in the panel, where it is a third.
  const source = lines(1, 11);
  const body = pending || narrative.body === null
    ? lines(1, 15)
    : source + lines(wrappedLines(narrative.body, 10, proseWidth), 15);
  const approved = narrative.actions.length === 0 ? 0 : 2 + listMm(narrative.actions, proseWidth - 4);
  const prose = body + approved;

  // The panel's own measure: a third of the page beside approved commentary,
  // and everything the placeholder does not want beside a pending one.
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

function kpiTileHeight(tile: KpiTile): number {
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
function tableMm(
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
 * One block's printed height.
 *
 * Charts state their own `heightMm`, so those are exact. Everything else is
 * the type scale above applied to the content the block carries.
 */
export function blockMm(block: PackPageBlock, orientation: PageOrientation): number {
  const width = PAGE_WIDTH_MM[orientation];
  switch (block.kind) {
    // `.pack-chart` is a `<figure>` with an explicit `height` — its caption
    // is drawn INSIDE that box, so the model is the number the chart states.
    case 'chart':
      return block.chart.heightMm;
    case 'smallMultiples': {
      const rows = Math.ceil(block.panels.length / 3);
      const panel = Math.max(0, ...block.panels.map((p) => p.heightMm));
      return rows * panel + Math.max(0, rows - 1) * GUTTER_MM;
    }
    case 'kpiTiles': {
      // Four to a grid row, and a grid row is as tall as the tallest tile IN
      // IT — not as the tallest in the block, which would charge a row of
      // one-line tiles for a five-line unavailable reason two rows below.
      let total = 0;
      for (let i = 0; i < block.tiles.length; i += 4) {
        total += (i === 0 ? 0 : GUTTER_MM)
          + Math.max(0, ...block.tiles.slice(i, i + 4).map(kpiTileHeight));
      }
      return total;
    }
    case 'table':
      return tableMm(
        block.table.rows.map((r) => r.label),
        block.table.rows.flatMap((r) => block.table.columns.map((c) => r.figures[c])),
        width,
        0.4,
      );
    case 'scorecard': {
      const groups = block.groups.reduce((sum, g, i) => sum + (i === 0 ? 0 : 4)
        + lines(wrappedLines(`${g.letter}. ${g.name}`, 11, width), 15) + 1.5
        + tableMm(g.rows.map((r) => r.metric), [], width, 0.34, SCORECARD_ROW_MM, SCORECARD_HEAD_MM), 0);
      const figures = block.groups.flatMap((g) => g.rows.flatMap((r) => [r.actual, r.prior]));
      return groups + 4 + notMeaningfulNotesMm(figures, width);
    }
    case 'matters': {
      // The one budget that already existed, converted to the units the rest
      // of the page is measured in — see `mattersTableMm` for why a row costs
      // its longest cell.
      return mattersTableMm(block.matters)
        + (block.omitted === null ? 0 : MATTERS_OMITTED_NOTE_MM);
    }
    case 'statTiles':
      return block.groups.reduce((sum, g, i) =>
        sum + (i === 0 ? 0 : 4) + lines(1, 15) + 1.5
        + Math.ceil(g.stats.length / 4) * (lines(2, 11) + 0.5 + lines(1, 16)), 0);
    case 'narrative':
      return narrativeMm(block.narrative, block.boardActions ?? [], orientation);
    case 'disclosure':
      return disclosureMm(block.disclosure, orientation);
    case 'definitions':
      return block.entries.reduce((sum, e, i) =>
        sum + (i === 0 ? 0 : 2)
        + lines(wrappedLines(e.term, 9.5, width), 14)
        + lines(wrappedLines(e.definition, 9.5, width - 4), 14)
        + (e.reconciliation?.length ? 1 + e.reconciliation.length * TABLE_ROW_MM : 0), 0);
  }
}

/** `.pack-page-header` — the page's name, its section eyebrow beside it, and
 *  the derived conclusion beneath, plus the `--pack-baseline` under the lot. */
export function pageHeaderMm(page: MeasurablePage, orientation: PageOrientation): number {
  const width = PAGE_WIDTH_MM[orientation];
  const namePt = orientation === 'landscape' ? 16 : 19;
  const titleLead = orientation === 'landscape' ? 13 : 15;
  const titlePt = orientation === 'landscape' ? 10.5 : 12;
  const margin = orientation === 'landscape' ? 2 : BLOCK_GAP_MM;
  return lines(1, namePt) + 0.5
    + lines(wrappedLines(page.title, titlePt, width), titleLead) + 1.5 + 0.71 + margin;
}

/** `.pack-footnotes` — 7.5pt over an 11pt leading, with 2mm of air above. */
export function footnotesMm(page: MeasurablePage, orientation: PageOrientation): number {
  if (page.footnotes.length === 0) return 0;
  const width = PAGE_WIDTH_MM[orientation];
  const n = page.footnotes.reduce((sum, f) => sum + wrappedLines(f.text, 7.5, width - 6), 0);
  return 2 + lines(n, 11);
}

/** The orientation this page is printed in, as the metrics name it. */
export function pageOrientation(page: MeasurablePage): PageOrientation {
  return page.orientation === 'landscape' ? 'landscape' : 'portrait';
}

/** Everything the page puts in its box: header, blocks, the gaps between
 *  them, and the footnotes. */
export function pageMm(page: MeasurablePage): number {
  const orientation = pageOrientation(page);
  const blocks = page.blocks.reduce((sum, b) => sum + blockMm(b, orientation), 0);
  const gaps = Math.max(0, page.blocks.length - 1) * BLOCK_GAP_MM;
  return pageHeaderMm(page, orientation) + blocks + gaps + footnotesMm(page, orientation);
}

/** The box this page is printed into. */
export function pageBoxMm(page: MeasurablePage): number {
  return PAGE_BOX_MM[pageOrientation(page)];
}
