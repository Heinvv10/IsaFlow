/**
 * HOW TALL A PAGE WILL BE, IN MILLIMETRES, BEFORE IT IS PRINTED.
 *
 * `selectPrintedMatters` already had a budget, because the matters table was
 * the block that overflowed the sheet the day someone looked. Then the
 * scorecard's cross-reference footnote overflowed onto a sheet of its own,
 * then the trends page's "Panels not drawn" block, on a different company.
 * Three overflows, three blocks, one cause: a budget that covered ONE of the
 * things that grows with data.
 *
 * A fixture derived from one failure is shaped like that failure, and the
 * next overflow comes from whatever the fixture did not copy. So this file
 * models EVERY block the pack can put on a page, and `fitPageToBox` declines
 * to compose a page that does not fit rather than leaving a browser to
 * discover it.
 *
 * THE CONTRACT IS THAT IT NEVER UNDER-ESTIMATES. Every constant below sits
 * on the pessimistic side of what was measured, and `packSheetCount.test.ts`
 * re-measures it page by page against Chromium's own layout on every fixture
 * the harness carries. An over-estimate costs a note that would have fitted;
 * an under-estimate costs the twelve-sheet contract. Not symmetrical.
 *
 * The type scale and the wrapping live in `packTextMetrics.ts`.
 */
import {
  lines,
  PAGE_BOX_MM,
  PAGE_WIDTH_MM,
  wrappedLines,
  type PageOrientation,
} from './packTextMetrics';
import {
  balancedLines,
  disclosureMm,
  GUTTER_MM,
  kpiTileHeight,
  MATTERS_OMITTED_NOTE_MM,
  narrativeMm,
  notMeaningfulNotesMm,
  SCORECARD_HEAD_MM,
  SCORECARD_ROW_MM,
  tableMm,
  DEFINITION_BRIDGE_ROW_MM,
  DEFINITION_BRIDGE_HEAD_MM,
} from './packBlockHeights';
import { mattersTableMm } from './packMattersPrinted';
import type { PackPage, PackPageBlock } from './packPageModel';

export { MATTERS_OMITTED_NOTE_MM };

/** A page as this file needs it — the number is assigned last, and the paper
 *  a page takes does not depend on it. */
export type MeasurablePage = Omit<PackPage, 'number'>;

/** `--pack-baseline`: the gap between two blocks. */
export const BLOCK_GAP_MM = 4.5;

/** `.pack-chart-title` in `packPrint.css`: 1.5mm clear of the plot beneath it.
 *  Only the SMALL MULTIPLES charge a caption here — a full-width chart draws
 *  its own inside its stated `heightMm`, so the 10pt/14pt pair that rule sets
 *  is not a number this model needs. */
const CHART_TITLE_GAP_MM = 1.5;

/** `.pack-small-multiples .pack-chart-title` — 8.5pt on a 12pt line. A page-10
 *  panel's caption is set at the glossary size over an 83mm measure; see the
 *  rule in `packPrint.css` for what the 10pt one cost that page. */
const PANEL_TITLE_PT = 8.5;
const PANEL_TITLE_LINE_PT = 12;

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
      // Two across (`repeat(2, 1fr)`), since the trends page became portrait.
      //
      // ROW BY ROW, AND THE CAPTION IS CHARGED SEPARATELY. A panel's
      // `heightMm` is its PLOT BOX; the figure is that plus its caption, and
      // the caption is the part that grows with the sentence. It used to be
      // charged as one flat figure height, which was only correct while every
      // caption fitted one line — and when one did not, the plot silently
      // shrank instead, which is what put the money group's shared y-domain
      // on two different painted scales. A grid row is as tall as the tallest
      // figure IN IT, so the tallest caption in the row is what it costs.
      const measure = (width - GUTTER_MM) / 2;
      let total = 0;
      for (let i = 0; i < block.panels.length; i += 2) {
        const row = block.panels.slice(i, i + 2);
        const captionLines = Math.max(1, ...row.map((p) => wrappedLines(p.title, PANEL_TITLE_PT, measure)));
        total += (i === 0 ? 0 : GUTTER_MM)
          + lines(captionLines, PANEL_TITLE_LINE_PT) + CHART_TITLE_GAP_MM
          + Math.max(0, ...row.map((p) => p.heightMm));
      }
      return total;
    }
    case 'kpiTiles': {
      // A grid row is as tall as the tallest tile IN IT, not as the tallest
      // in the block — which would charge a row of one-line tiles for a
      // five-line unavailable reason two rows below.
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
      // See `mattersTableMm` for why a row costs its longest cell.
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
    case 'definitions': {
      // A GLOSSARY IN TWO COLUMNS (`column-count: 2`). Sixteen terms set
      // across the full measure came to 312mm on a 255mm sheet. Each entry is
      // `break-inside: avoid`, so the block is as tall as the taller column
      // AND never shorter than its tallest single entry — EBITDA's carries a
      // three-row reconciliation table that cannot split.
      const measure = (width - GUTTER_MM) / 2;
      const heights = block.entries.map((e) =>
        lines(wrappedLines(e.term, 8.5, measure), 12)
        + lines(wrappedLines(e.definition, 8.5, measure - 4), 12)
        // AND THE COMPARATIVE COLUMN'S HEADER ROW, where the bridge carries
        // one — a `<thead>` is a row of paper like any other, and page 12
        // fits with about 1.7mm to spare, so an unmeasured row is a sheet.
        // 0.4 is `.pack-definition-bridge`'s own `margin-top`; it was 1mm,
        // and page 12 is measured to a tenth.
        + (e.reconciliation?.length
          ? 0.4 + e.reconciliation.length * DEFINITION_BRIDGE_ROW_MM
            // AND THE COMPARATIVE COLUMN'S HEADER ROW, where the bridge
            // carries one. A `<thead>` is a row of paper like any other —
            // charged at a `td`'s 7mm it came out 0.9mm short of the browser,
            // and page 12 fits with about 1.7mm to spare, so an unmeasured
            // row is a thirteenth sheet.
            + (e.reconciliation.some((step) => step.comparative !== undefined) ? DEFINITION_BRIDGE_HEAD_MM : 0)
          : 0)
        // `.pack-definition-bridge-note` — 7.5pt over an 11pt line, 1mm clear
        // of the bridge above it. Charged, because an entry that grows and is
        // not measured is how a page takes a thirteenth sheet.
        + (e.reconciliationNote === undefined
          ? 0
          : 1 + lines(wrappedLines(e.reconciliationNote, 7.5, measure - 4), 11)));
      // Chromium balances by finding the smallest height a greedy in-order
      // fill still clears, which with `break-inside: avoid` is the best
      // in-order split — `balancedLines` computes exactly that rather than
      // approximating it. `total / 2` reads short by up to a whole entry;
      // `total / 2 + the tallest` cost the page forty millimetres it did not
      // have.
      // 2mm is `.pack-definition + .pack-definition`'s margin, charged per
      // column rather than per entry — see `balancedLines`.
      return balancedLines(heights, 2);
    }
  }
}

/** `.pack-page-header` — the page's name, its section eyebrow beside it, and
 *  the derived conclusion beneath, plus the `--pack-baseline` under the lot. */
export function pageHeaderMm(page: MeasurablePage, orientation: PageOrientation): number {
  const width = PAGE_WIDTH_MM[orientation];
  // The eyebrow row — the page's name and its section, both 8pt on an 11pt
  // line. One line always: two short small-caps labels at either end of the
  // measure.
  const titleLead = orientation === 'landscape' ? 16 : 18;
  const titlePt = orientation === 'landscape' ? 13 : 15;
  const margin = orientation === 'landscape' ? 2 : BLOCK_GAP_MM;
  return lines(1, 11) + 0.5
    + lines(wrappedLines(page.title, titlePt, width), titleLead) + 1.5 + 0.71 + margin;
}

/**
 * `.pack-footnotes` — 7.5pt over an 11pt leading, with 2mm of air above.
 *
 * The strip used to be pinned to the bottom of the page's flex column by
 * `margin-top: auto`, which measures nothing and left the two grey lines on
 * page 5 marooned under half a sheet of white. It follows its content now,
 * and the 2mm above it did not change: the live balance sheet composes at
 * 253.6mm in a 255mm box and the cash page at less than one, so a millimetre
 * added here refuses a page or buys a chart with a sentence. Measured, in
 * `packPagesKeepTheirProse` and `boardPackPages.test.ts`.
 */
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
