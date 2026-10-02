/**
 * The contents page held to its sheet — the fit, and the measure of the index
 * the page's blocks do not account for. Split out of `packFrontMatter.ts` for
 * the 300-line cap; that file re-exports `fitContentsPage` and
 * `contentsListMm`, so every caller still imports them there.
 */
import { fitPageToBox } from './packPageFit';
import { lines, PAGE_WIDTH_MM, PT_MM, wrappedLines } from './packTextMetrics';
import type { UnnumberedPage } from './packUnnumberedPage';

/**
 * THE CONTENTS PAGE, HELD TO ITS SHEET.
 *
 * It carries the caveats now, and a company with four long ones would
 * otherwise push the pack to a thirteenth sheet from the FRONT — the one
 * place nothing was measured, because until now page 2 was a twelve-line
 * index and a paragraph. The caveats are a required disclosure, so the
 * fitter reaches them only after this page's own optional prose, never takes
 * the first of them, and says on the page what it took.
 *
 * WHATEVER IT TAKES, THE BASIS PAGE'S STANDFIRST HAS TO KNOW. That sentence
 * counts the caveats that qualify the figures and names where they print; a
 * count composed before this fit is a count this fit can falsify, which is
 * the exact defect the basis page was rejected for once already. So the
 * caller fits this page FIRST and hands `printedCaveats` to
 * `buildBasisPage` — see `boardPackPages`.
 */
export function fitContentsPage(page: UnnumberedPage, navLabels: string[]): UnnumberedPage {
  return fitPageToBox(page, contentsListMm(navLabels));
}

/**
 * The measure a contents row sets its LABEL across.
 *
 * `.pack-contents-item` is a flex row: the page number, then the label, then
 * the space between them. The number is one or two figures at 10pt with a 3mm
 * margin — under 8mm — and 10 is the pessimistic reading of it, because the
 * direction that matters here is the one that spills a sheet.
 */
const CONTENTS_LABEL_MM = PAGE_WIDTH_MM.portrait - 10;

/**
 * The paper `PackContents` draws that this page's BLOCKS do not account for:
 * the index itself.
 *
 * It is not a block — the component builds it from the page list — so
 * `pageMm` reports this sheet at a third of its real height, which was
 * harmless while the page carried one paragraph and is not now that it
 * carries the caveats. Transcribed from `.pack-contents-list` and
 * `.pack-contents-item` in `packPrint.css`: a 4mm top margin, then per row a
 * 10pt line at 16pt leading, 1mm of padding either side and a half-point
 * rule.
 *
 * IT TAKES THE LABELS, NOT A COUNT, AND THAT IS THE CORRECTION. It assumed
 * one line per entry and never saw the strings. Twelve short labels — "Income
 * statement", "Matters" — fit that assumption; an eighteen-page management
 * pack with longer ones does not, and a wrapped label makes this formula
 * UNDER-read, which is the one direction that puts a page on a second sheet
 * under an index that says otherwise. It is now measured the way every other
 * block on every other page is measured, through `wrappedLines`, and
 * `packSheetCount.test.ts` holds page 2 to Chromium's own layout like the
 * ten pages after it.
 */
export function contentsListMm(navLabels: string[]): number {
  const rowLines = navLabels.reduce(
    (sum, label) => sum + wrappedLines(label, 10, CONTENTS_LABEL_MM), 0);
  return 4 + lines(rowLines, 16) + navLabels.length * (2 + 0.5 * PT_MM);
}
