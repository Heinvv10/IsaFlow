/**
 * A board pack as the pages API served it BEFORE figure fits were stamped on the server: the same wire shape, with no
 * `fit` on a KPI row and no `figureFit` on a statement table (the page decided them itself then, at render). Made
 * from today's document by removing exactly those two fields, which is the whole difference in shape.
 */
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { serialisePackPagesDocument, type SerialisedPackPagesDocument } from '@/modules/accounting/services/packs/pages/packDocumentWire';
import { demoInput } from './boardPackInputs';

export function storedBeforeStampedFits(): SerialisedPackPagesDocument {
  const wire = JSON.parse(JSON.stringify(serialisePackPagesDocument(buildBoardPackPages(demoInput)))) as SerialisedPackPagesDocument;
  for (const page of wire.pages as unknown as Array<{ blocks: Array<Record<string, unknown> & { table?: Record<string, unknown> }> }>) {
    for (const block of page.blocks) {
      delete block.fit;
      if (block.table !== undefined) delete block.table.figureFit;
    }
  }
  return wire;
}
