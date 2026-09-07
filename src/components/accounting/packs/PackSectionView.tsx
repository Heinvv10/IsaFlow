/**
 * One pack section, printed. Renders PackBlocks and nothing else — every
 * figure arrives already chosen by buildPackDocument.
 */
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import { waterfallOption, trendOption } from '@/modules/accounting/services/packs/packChartOptions';
import type { PackBlock, PackDocumentSection } from '@/modules/accounting/services/packs/packDocument';
import { formatPackKv, scorecardFigure } from '@/modules/accounting/services/packs/packKvFormat';
import { PackChart } from './PackChart';

const NO_COMPARATORS = { prior: false, budget: false, variance: false, trend: false } as const;

// `formatPackKv` is re-exported so the page keeps its existing import path
// while the one implementation lives in the service layer.
export { formatPackKv };

function Block({ block }: { block: PackBlock }) {
  switch (block.kind) {
    case 'statement':
      return <StatementGrid rows={block.rows} columns={NO_COMPARATORS} cents />;

    case 'kv':
      return (
        <dl className="grid grid-cols-3 gap-3">
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
        <div className="grid grid-cols-3 gap-2">
          {block.items.map((item) => {
            // The scored/unscored decision is `scorecardFigure`'s, not this
            // renderer's — the screen wrote its own and called .toFixed(2) on
            // a null value.
            const figure = scorecardFigure(item);
            return (
              <div key={item.ratioKey} className="rounded border border-[var(--ff-border-light)] p-2 text-xs">
                <span className="block text-[var(--ff-text-tertiary)]">{item.name}</span>
                {figure.scored ? (
                  <>
                    <span className="font-bold tabular-nums text-[var(--ff-text-primary)]">{figure.value}</span>
                    <span className="ml-1 text-[var(--ff-text-tertiary)]">/ {figure.target}</span>
                  </>
                ) : (
                  <span className="text-[var(--ff-text-tertiary)]">{figure.reason}</span>
                )}
              </div>
            );
          })}
        </div>
      );

    case 'waterfall':
      return <PackChart option={waterfallOption(block.steps)} />;

    case 'trend':
      // Revenue is the series a reader quotes off a twelve-month page; the
      // other two are on the statements a page earlier.
      return <PackChart option={trendOption(block.points.map((p) => ({ label: p.label, value: p.revenue })))} />;

    case 'text':
      return <p className="text-sm text-[var(--ff-text-secondary)]">{block.text}</p>;
  }
}

export function PackSectionView({ section }: { section: PackDocumentSection }) {
  return (
    <section
      data-print-break
      {...(section.landscape ? { 'data-print-landscape': '' } : {})}
      id={`pack-section-${section.type}`}
      className="space-y-4"
    >
      <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">{section.title}</h2>
      {section.blocks.map((block, i) => (
        <Block key={`${section.type}-${i}`} block={block} />
      ))}
    </section>
  );
}
