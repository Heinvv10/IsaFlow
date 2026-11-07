/**
 * A PACK AS IT WOULD PRINT IF THE FLOOR GATE LET IT: every row the fit model says fits at no size is set at the floor
 * (the size its stamp names) instead of refused.
 *
 * A page refuses a row whose stamp says it does not fit (`packFigureFitCss.fitAttributes`), as production must. A test
 * that proves a refusal is RIGHT (the row really runs past the edge at the floor) has to print exactly that row, so it
 * says so here, in one place, rather than the page learning to print it.
 */
import type { FigureFit, StampedPackPagesDocument } from '@/modules/accounting/services/packs/pages/packFigureFitCss';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';

const forced = (fit: FigureFit | undefined): FigureFit | undefined => (fit !== undefined && !fit.fits ? { px: fit.px, fits: true } : fit);

export function atTheFloor(doc: PackPagesDocument): StampedPackPagesDocument {
  return {
    ...doc,
    pages: doc.pages.map((page) => ({
      ...page,
      blocks: page.blocks.map((block) => {
        if (block.kind === 'table') return { ...block, table: { ...block.table, figureFit: forced(block.table.figureFit) } };
        if (block.kind === 'kpiTiles') return { ...block, fit: forced(block.fit) };
        return block;
      }),
    })),
  } as StampedPackPagesDocument;
}
