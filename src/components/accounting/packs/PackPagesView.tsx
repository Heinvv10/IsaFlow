/**
 * The fixed-page board pack, root to leaf: one `.pack-page` per model page,
 * the brand style block, and `data-print-ready` for the PDF transport.
 *
 * Rendered "false" rather than omitted while the document is loading, same
 * reasoning as the legacy `PackPrintView`: a selector typo in the renderer
 * fails loudly on timeout instead of matching a half-drawn page. See
 * usePrintMode.ts for why there is no timeout behind it.
 *
 * Pages 1 and 2 are dispatched to their own components because their layout
 * is not a block list — a cover is a centred title block and a contents page
 * is a numbered index of the other eleven. Their model BLOCKS still render,
 * inside them: page 1 carries the confidentiality and preparer disclosure
 * and page 2 the short basis note, both of which spec §5.4/§4.A require and
 * neither of which a layout component may invent for itself. Every other
 * page is `PackPageFrame` plus `PackBlocks`.
 */
import { packBrandStyleBlock } from '@/modules/accounting/services/packs/packBrand';
import { toMoneyScale } from '@/lib/format/money';
import { useEffect } from 'react';
import { unstampedFigure, type StampedPackPagesDocument } from '@/modules/accounting/services/packs/pages/packFigureFitCss';
import { PackPageFrame } from './PackPageFrame';
import { PackBlocks } from './pages/PackBlocks';
import { PackCoverV2 } from './primitives/PackCoverV2';
import { PackContents } from './primitives/PackContents';
import { countPageModelCharts, markPrintError, usePrintMode, usePrintReady } from './usePrintMode';

export interface PackPagesViewProps {
  document: StampedPackPagesDocument | null;
}

/**
 * The document's scale, re-checked at the render boundary.
 *
 * `numberConvention.scale` is now typed `MoneyScale`, so this cannot fail on
 * a document composed in this process — and it is kept anyway, because a
 * TYPE is not a runtime guarantee for a document that arrived over the wire.
 * `adoptPackPagesDocument` narrows it there; this is the last check before
 * the figures are actually formatted, and printing unscaled cells under a
 * header that says "R'000" is the exact 1000x misread R-P52 exists to stop.
 * A render that stops is a diagnosable failure; a pack that prints every
 * figure a thousand times too large is one a director forwards to a bank.
 */
function requireScale(document: StampedPackPagesDocument) {
  const scale = toMoneyScale(document.numberConvention.scale);
  if (scale === null) {
    throw new Error(
      `PackPagesView: the pack states its figures in '${document.numberConvention.scale}', ` +
        `which is not a scale any formatter knows. Refusing to print figures at an unknown scale.`,
    );
  }
  return scale;
}

export function PackPagesView({ document }: PackPagesViewProps) {
  usePrintMode(true);
  // A table or KPI row without the figure size the server decided (or one that does not fit) is not printed at a size
  // nobody checked: the page renders no pages, never becomes ready, and says why. The type says every block has one;
  // this is the run-time check behind it, for a document that reached the page by any other road than the adopter.
  const unprintable = document ? unstampedFigure(document) : null;
  useEffect(() => {
    if (unprintable !== null) markPrintError('pages', unprintable);
  }, [unprintable]);
  const printable = unprintable === null ? document : null;
  const ready = usePrintReady(printable !== null, printable ? countPageModelCharts(printable.pages) : 0);
  const scale = printable ? requireScale(printable) : null;

  return (
    <div
      className="pack-pages mx-auto max-w-[210mm] bg-white p-0 text-[var(--ff-text-primary)]"
      data-print-ready={ready ? 'true' : 'false'}
      {...(printable?.draft ? { 'data-pack-draft': '' } : {})}
    >
      {printable && scale && (
        <>
          <style>{packBrandStyleBlock(printable.brand)}</style>
          {printable.pages.map((page) => {
            const blocks = <PackBlocks page={page} scale={scale} />;
            if (page.number === 1) {
              return <PackCoverV2 key={page.number} document={printable}>{blocks}</PackCoverV2>;
            }
            if (page.number === 2) {
              return <PackContents key={page.number} pages={printable.pages}>{blocks}</PackContents>;
            }
            return (
              <PackPageFrame key={page.number} page={page}>
                {blocks}
              </PackPageFrame>
            );
          })}
        </>
      )}
    </div>
  );
}
