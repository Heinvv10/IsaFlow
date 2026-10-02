/**
 * WHICH OF PAGE 4'S TWO LAYOUTS THE NARRATIVE BLOCK IS DRAWN IN — decided
 * BEFORE the page is held to its sheet, because it is a layout decision and
 * not a trim.
 *
 * A SIGNED COMMENTARY REFUSED THE WHOLE DOCUMENT, AND THE COMMENTARY WAS NOT
 * THE CAUSE. `.pack-narrative-columns` is `2fr 1fr` for an approved narrative
 * and one full-measure column for a pending one, so signing the commentary
 * moved the DERIVED action panel — which comes from the matters model and has
 * nothing to do with the commentary — out of 174mm of measure and into 43mm.
 * The live demo company's three actions cost 75.1mm at the first and 183.2mm
 * at the second: page 4 needed 288.7mm of a 255mm sheet and
 * `buildBoardPackPages` threw. It threw for a six-word commentary as readily
 * as for a long one — the body's length is not a variable, and the page
 * measured the same 288.7mm on a body twenty times longer. Brightsphere
 * survived only because it has ONE derived action; the demo's threshold is
 * three, and `boardActionItems` derives those from the matters, so three is
 * ordinary. Nothing stores board commentary yet, so every fixture carries
 * `commentary: null` and none of ten thousand tests saw it.
 *
 * SO THE PANEL STACKS UNDER THE PROSE, at the measure it already takes beside
 * a pending placeholder. It invents no layout: the pack already draws this
 * exact block single-column, and a reader has already seen that shape. It
 * chooses no number and gives up no content — every derived action still
 * prints, in full, in the order it came.
 *
 * AND IT IS NOT A LEVER OF `fitPageToBox`. That function takes disclosure
 * notes and page footnotes and nothing else, and the list of what it may take
 * is the guarantee that no FIGURE is ever trimmed off a sheet; a layout
 * decision does not belong in it. This runs first, on the page as composed,
 * and hands the fitter a page whose blocks are already in the shape they will
 * print in.
 *
 * A PAGE THAT ALREADY FITS IS LEFT ALONE. Side by side is what page 4 was
 * designed around and it is kept wherever it goes on the paper; this is the
 * shape it falls back to, not a replacement for it.
 */
import { pageBoxMm, pageMm, type MeasurablePage } from './packPageMetrics';

export function relaidNarrative<T extends MeasurablePage>(page: T): T {
  if (pageMm(page) <= pageBoxMm(page)) return page;
  const index = page.blocks.findIndex((b) => b.kind === 'narrative'
    && (b.boardActions ?? []).length > 0 && b.stackActions !== true);
  if (index === -1) return page;
  const block = page.blocks[index]!;
  if (block.kind !== 'narrative') return page;
  const blocks = [...page.blocks];
  blocks[index] = { ...block, stackActions: true };
  const relaid = { ...page, blocks };
  // AND ONLY WHERE IT HELPS. The stacked shape is shorter than the columns
  // for every panel this pack produces — a list at a third of the measure is
  // about two and a half times its own height — but a page is not made worse
  // to satisfy a rule: where the two-column layout is the shorter one it
  // stays, and the fitter deals with the page as it was composed.
  return pageMm(relaid) < pageMm(page) ? relaid : page;
}
