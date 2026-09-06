/**
 * The fixed-page board pack, root to leaf: one `.pack-page` per model page,
 * the brand style block, and `data-print-ready` for the PDF transport.
 *
 * Rendered "false" rather than omitted while the document is loading, same
 * reasoning as the legacy `PackPrintView`: a selector typo in the renderer
 * fails loudly on timeout instead of matching a half-drawn page. See
 * usePrintMode.ts for why there is no timeout behind it.
 *
 * Block content (KPI tiles, tables, charts, …) is a later task's job — this
 * component renders the page shells only, via `PackPageFrame`.
 */
import { packBrandStyleBlock } from '@/modules/accounting/services/packs/packBrand';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { PackPageFrame } from './PackPageFrame';
import { countPageModelCharts, usePrintMode, usePrintReady } from './usePrintMode';

export interface PackPagesViewProps {
  document: PackPagesDocument | null;
}

export function PackPagesView({ document }: PackPagesViewProps) {
  usePrintMode(true);
  const ready = usePrintReady(document !== null, document ? countPageModelCharts(document.pages) : 0);

  return (
    <div
      className="pack-pages mx-auto max-w-[210mm] bg-white p-0 text-[var(--ff-text-primary)]"
      data-print-ready={ready ? 'true' : 'false'}
      {...(document?.draft ? { 'data-pack-draft': '' } : {})}
    >
      {document && (
        <>
          <style>{packBrandStyleBlock(document.brand)}</style>
          {document.pages.map((page) => (
            <PackPageFrame key={page.number} page={page} />
          ))}
        </>
      )}
    </div>
  );
}
