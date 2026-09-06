/**
 * The pack as the renderer photographs it: cover, contents, then one section
 * per page.
 *
 * `data-print-ready` on the root is the renderer's only gate — it waits for
 * [data-print-ready="true"] and then calls page.pdf(). It is deliberately
 * rendered as "false" rather than omitted while the document is loading, so a
 * selector typo in the renderer fails loudly on timeout instead of matching a
 * half-drawn page. See usePrintMode.ts for why there is no timeout behind it.
 */
import { PackCover } from './PackCover';
import { PackToc } from './PackToc';
import { PackSectionView } from './PackSectionView';
import { countCharts, usePrintMode, usePrintReady } from './usePrintMode';
import type { PackDocument } from '@/modules/accounting/services/packs/packDocument';

export function PackPrintView({ document }: { document: PackDocument | null }) {
  usePrintMode(true);
  const ready = usePrintReady(document !== null, document ? countCharts(document.sections) : 0);

  return (
    <div
      data-print-ready={ready ? 'true' : 'false'}
      className="mx-auto max-w-[190mm] bg-white p-0 text-[var(--ff-text-primary)]"
    >
      {document && (
        <>
          <PackCover document={document} />
          <PackToc document={document} />
          {document.sections.map((section) => (
            <PackSectionView key={section.type} section={section} />
          ))}
        </>
      )}
    </div>
  );
}
