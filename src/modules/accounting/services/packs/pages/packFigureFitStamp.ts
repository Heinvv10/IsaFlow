/**
 * EVERY STATEMENT TABLE AND KPI ROW OF A PACK CARRIES THE SIZE ITS FIGURES PRINT AT, decided here, on the server.
 *
 * The fit (`packFigureFit`) shapes text from the pack's font files, which only the server has; the page that prints
 * the pack renders what the document says (`packFigureFitCss.fitAttributes`). Stamped at the end of composition
 * (`buildBoardPackPages`) and again where a document leaves the server (the pages API), so a document built before
 * fits were stamped, or edited since, is never served without them; the wire adopter refuses one that arrives without.
 * The stamp is computed afresh every time, never trusted from the document.
 */
import type { MoneyScale } from '@/lib/format/money';
import { kpiFit, tableFit } from './packFigureFit';
import type { PackPageBlock, PackPagesDocument } from './packPageModel';
import type { PageOrientation } from './packTextMetrics';

export function stampBlock(block: PackPageBlock, scale: MoneyScale, orientation: PageOrientation): PackPageBlock {
  if (block.kind === 'table') return { ...block, table: { ...block.table, figureFit: tableFit(block.table, scale, orientation) } };
  if (block.kind === 'kpiTiles') return { ...block, fit: kpiFit(block.tiles, scale, orientation) };
  return block;
}

export function stampFigureFits(doc: PackPagesDocument): PackPagesDocument {
  const scale = doc.numberConvention.scale;
  return { ...doc, pages: doc.pages.map((page) => ({ ...page, blocks: page.blocks.map((block) => stampBlock(block, scale, page.orientation)) })) };
}
