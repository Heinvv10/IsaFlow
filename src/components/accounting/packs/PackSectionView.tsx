/**
 * One pack section, printed. Renders PackBlocks and nothing else — every
 * figure arrives already chosen by buildPackDocument.
 */
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import { waterfallOption } from '@/modules/accounting/services/packs/packChartOptions';
import type { MoneyScale } from '@/lib/format/money';

/**
 * The legacy accordion pack states every figure in RANDS — it carries no
 * `numberConvention` and its KV items are formatted unscaled (`packKvFormat`).
 * Stated here rather than defaulted inside `waterfallOption`, because a
 * default is what let the fixed-page pack draw rand axes under an `R'000`
 * header; this pack's charts and its own tables agree at 'R'.
 */
const LEGACY_PACK_SCALE: MoneyScale = 'R';
import type { PackBlock, PackDocumentSection } from '@/modules/accounting/services/packs/packDocument';
import { formatPackKv, scorecardFigure } from '@/modules/accounting/services/packs/packKvFormat';
import { legacyTrendCaption, legacyTrendChartOption } from '@/modules/accounting/services/packs/packLegacyTrend';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { PackChart } from './PackChart';
import { PACK_FONT_STACK } from '@/lib/charts/packFont';

/**
 * THE BOX THIS VIEW'S BRIDGE IS DRAWN IN, AND IT IS A FIXED ONE.
 *
 * The only caller is `PackPrintView`, whose root is `max-w-[174mm]` — A4
 * less the transport's 18mm side margins (`PDF_MARGIN_MM`), the width a
 * PORTRAIT sheet really holds — and no section is landscape any more
 * (`isLandscapeSection`), so the chart's container is 174mm wide in every
 * render the PDF transport makes. 174mm is 657 CSS pixels. (It was 190mm /
 * 718px, tuned for a landscape sheet; on a portrait one that overran the right
 * margin by 16mm.) `PackChart` is given that width
 * outright rather than `100%`, so it is 657 on a narrow browser window too:
 * the layout below is chosen for one known rectangle and that is the
 * rectangle drawn. A bridge in a container narrower than its own axis labels
 * — measured at 360px, where ECharts squeezed the plot to nothing — cannot
 * occur. `packLegacyBridgeWidth.dom.test.tsx` pins the two together.
 */
export const LEGACY_WATERFALL_BOX = { heightPx: 320, widthPx: 657 } as const;

/**
 * THIS VIEW'S CHARTS ARE SET IN THE PACK'S PRINT FACE, NOT THE SCREEN'S.
 *
 * `EChart` registers the app's chart theme, whose text face is
 * `--ff-fig-font` — IBM Plex Mono. The print page loads no such face (it
 * self-hosts IBM Plex Sans, the face the readiness gate waits for), so every
 * axis label on these charts fell back to whatever monospace the renderer
 * had: DejaVu Sans Mono in the Gotenberg image, a second typeface embedded in
 * a pack that declares one. An option's own `textStyle` overrides a theme's,
 * so the family is stated here, on every chart this view draws.
 */
function inPrintFace<T extends object>(option: T): T & { textStyle: { fontFamily: string } } {
  return { ...option, textStyle: { fontFamily: PACK_FONT_STACK } };
}

/**
 * The bridge option this view draws — exported so a test renders exactly it.
 * The same exact-plot layout as the board pack, in the same face.
 */
export function legacyWaterfallOption(
  steps: Parameters<typeof waterfallOption>[0],
  box: { heightPx: number; widthPx: number } = LEGACY_WATERFALL_BOX,
) {
  return inPrintFace(waterfallOption(steps, LEGACY_PACK_SCALE, undefined, undefined, false, undefined, box));
}

/** The twelve-month trend this view draws — revenue, the series a reader
 *  quotes off the page; the other two are on the statements a page earlier.
 *  See `packLegacyTrend` for what it says and where it starts. */
export function legacyTrendOption(points: PackTrendPoint[]) {
  return inPrintFace(legacyTrendChartOption(points, LEGACY_PACK_SCALE));
}
export { legacyTrendCaption };

const NO_COMPARATORS = { prior: false, budget: false, variance: false, trend: false } as const;

// `formatPackKv` is re-exported so the page keeps its existing import path
// while the one implementation lives in the service layer.
export { formatPackKv };

function Block({ block }: { block: PackBlock }) {
  switch (block.kind) {
    case 'statement':
      return <div className="pack-legacy-card"><StatementGrid rows={block.rows} columns={NO_COMPARATORS} cents /></div>;

    case 'kv':
      return (
        <dl className="pack-legacy-kv grid grid-cols-3 gap-3">
          {block.items.map((item) => (
            <div key={item.label}>
              <dt className="text-xs text-[var(--ff-text-tertiary)]">{item.label}</dt>
              <dd className="text-sm font-medium text-[var(--ff-text-primary)] tabular-nums">{formatPackKv(item)}</dd>
            </div>
          ))}
        </dl>
      );

    case 'scorecard':
      return (
        <div className="pack-legacy-kv pack-legacy-card grid grid-cols-3 gap-2">
          {block.items.map((item) => {
            // The scored/unscored decision is `scorecardFigure`'s, not this
            // renderer's — the screen wrote its own and called .toFixed(2) on
            // a null value.
            const figure = scorecardFigure(item);
            return (
              <div key={item.ratioKey} className="rounded border border-[var(--ff-border-light)] p-2 text-xs">
                {/* Secondary ink, not tertiary: #9ca3af on white is 2.5:1, and
                  * the reason is the card's whole content where it has no figure. */}
                <span className="pack-legacy-card-note block text-[var(--ff-text-secondary)]">{item.name}</span>
                {figure.scored ? (
                  <>
                    <span className="font-bold tabular-nums text-[var(--ff-text-primary)]">{figure.value}</span>
                    <span className="pack-legacy-card-note ml-1 text-[var(--ff-text-secondary)]">/ {figure.target}</span>
                  </>
                ) : (
                  <span className="pack-legacy-card-note text-[var(--ff-text-secondary)]">{figure.reason}</span>
                )}
              </div>
            );
          })}
        </div>
      );

    case 'waterfall':
      return <PackChart height={LEGACY_WATERFALL_BOX.heightPx} width={LEGACY_WATERFALL_BOX.widthPx} option={legacyWaterfallOption(block.steps)} />;

    case 'trend':
      return (
        <>
          <PackChart option={legacyTrendOption(block.points)} />
          <p className="text-xs text-[var(--ff-text-secondary)]">{legacyTrendCaption(block.points)}</p>
        </>
      );

    case 'text':
      return <p className="text-sm text-[var(--ff-text-secondary)]">{block.text}</p>;
  }
}

type KvBlock = Extract<PackBlock, { kind: 'kv' }>;

/**
 * A SECTION THAT IS ONE LONG KEY/VALUE GRID, AS A TABLE, so that it can repeat
 * its heading. The ratios grid is long enough to cross a sheet, and the sheet
 * it continues onto had no heading at all. The heading lives in the table's
 * `<thead>`, which Chromium's print layout repeats at the top of every sheet
 * the table spans — the one repeating construct it supports reliably (a CSS
 * grid cannot, and `position: running()` is not implemented). It repeats
 * verbatim: print CSS cannot tell the first copy from a repeat, so the
 * continuation reads "<Section>" and not "<Section> (continued)".
 */
function KvSection({ section, block }: { section: PackDocumentSection; block: KvBlock }) {
  const rows: KvBlock['items'][] = [];
  for (let i = 0; i < block.items.length; i += 3) rows.push(block.items.slice(i, i + 3));
  return (
    <section
      id={`pack-section-${section.type}`}
      className="pack-legacy-kv-section"
    >
      <table className="pack-legacy-kv-table w-full border-collapse">
        <thead>
          <tr>
            <th colSpan={3} className="pack-legacy-heading text-left">
              <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">{section.title}</h2>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row[0]!.label}>
              {row.map((item) => (
                <td key={item.label} className="align-top">
                  <div className="text-xs text-[var(--ff-text-tertiary)]">{item.label}</div>
                  <div className="text-sm font-medium text-[var(--ff-text-primary)] tabular-nums">{formatPackKv(item)}</div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function PackSectionView({ section }: { section: PackDocumentSection }) {
  const only = section.blocks.length === 1 ? section.blocks[0] : undefined;
  if (only?.kind === 'kv' && section.blocks.length === 1) return <KvSection section={section} block={only} />;
  return (
    <section
      {...(section.landscape ? { 'data-print-landscape': '' } : {})}
      id={`pack-section-${section.type}`}
      className="space-y-4"
    >
      <h2 className="pack-legacy-heading text-lg font-semibold text-[var(--ff-text-primary)]">{section.title}</h2>
      {section.blocks.map((block, i) => (
        <Block key={`${section.type}-${i}`} block={block} />
      ))}
    </section>
  );
}
