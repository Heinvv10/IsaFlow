/**
 * One page's blocks, rendered. The dispatcher from `PackPageBlock`'s union
 * to the primitives that draw each kind.
 *
 * THE PAGES ARE NOT TWELVE COMPONENTS. Spec §4.A's twelve pages differ in
 * WHICH blocks they carry, not in how a block is drawn — that is what the
 * block union is for, and IBCS Unify is explicit that one organisation
 * draws one KPI tile, not twelve. Twelve page components would be twelve
 * places for the same tile to drift, and the management pack (WS4c) reuses
 * pages 1-8 wholesale. The two pages that genuinely have their own layout
 * rather than a block list — the cover and the contents — already have
 * their own components and are dispatched in `PackPagesView`.
 *
 * The switch is exhaustive over the union, and the `never` assignment below
 * is what enforces it: a block kind added to the model without a renderer
 * here is a compile error, not a silently blank region of a board pack.
 * There is still deliberately no runtime "unknown kind" branch, but the
 * reason has changed: R-P41's "composed in the same process" guarantee is
 * gone — the board pack is now composed server-side and PARSED FROM JSON by
 * the print page, because `renderChartSvg` cannot run in a browser. What
 * takes its place is `adoptBlock` in `packDocumentWire.ts`, the single
 * deserialisation boundary, which refuses an unknown kind (and re-brands
 * every chart through the guards) before a block can reach this switch.
 */
import { KpiTileWithSparkline } from '../primitives/KpiTileWithSparkline';
import { ComparativeTable } from '../primitives/ComparativeTable';
import { ScorecardTable } from '../primitives/ScorecardTable';
import { NarrativeColumns } from '../primitives/NarrativeColumns';
import { StatTile } from '../primitives/StatTile';
import { MattersTable } from '../primitives/MattersTable';
import { PackChartBlock, PackSmallMultiples } from './PackChartBlock';
import { PackDefinitionsBlock, PackDisclosureBlock } from './PackNoteBlocks';
import type { MoneyScale } from '@/lib/format/money';
import type {
  PackPage,
  PackPageBlock,
} from '@/modules/accounting/services/packs/pages/packPageModel';

export interface PackBlockViewProps {
  block: PackPageBlock;
  /** The document's `numberConvention.scale`. Required at every level of
   *  this tree for the reason `formatFigureText` gives: an optional scale
   *  makes the 1000x misread the default path. */
  scale: MoneyScale;
}

export function PackBlockView({ block, scale }: PackBlockViewProps) {
  switch (block.kind) {
    case 'kpiTiles':
      return (
        <div className="pack-kpi-tiles">
          {block.tiles.map((tile, index) => (
            <KpiTileWithSparkline key={`${tile.label}-${index}`} tile={tile} scale={scale} />
          ))}
        </div>
      );
    case 'statTiles':
      return (
        <div className="pack-stat-groups">
          {block.groups.map((group) => (
            <div key={group.heading} className="pack-stat-group">
              <h3 className="pack-stat-group-heading">{group.heading}</h3>
              <div className="pack-stat-tiles">
                {group.stats.map((stat, index) => (
                  <StatTile key={`${stat.label}-${index}`} stat={stat} scale={scale} />
                ))}
              </div>
            </div>
          ))}
        </div>
      );
    case 'table':
      return <ComparativeTable table={block.table} scale={scale} />;
    case 'scorecard':
      return <ScorecardTable groups={block.groups} scale={scale} priorFootnote={block.priorFootnote ?? null} />;
    case 'chart':
      return <PackChartBlock chart={block.chart} />;
    case 'smallMultiples':
      return <PackSmallMultiples panels={block.panels} />;
    case 'narrative':
      return <NarrativeColumns narrative={block.narrative} boardActions={block.boardActions} />;
    case 'disclosure':
      return <PackDisclosureBlock disclosure={block.disclosure} />;
    case 'definitions':
      return <PackDefinitionsBlock entries={block.entries} scale={scale} />;
    case 'matters':
      return <MattersTable matters={block.matters} omitted={block.omitted} scale={scale} />;
    default: {
      // Exhaustiveness, checked by the compiler. See the file header.
      const unreachable: never = block;
      return unreachable;
    }
  }
}

export interface PackBlocksProps {
  page: PackPage;
  scale: MoneyScale;
}

export function PackBlocks({ page, scale }: PackBlocksProps) {
  return (
    <>
      {page.blocks.map((block, index) => (
        // `data-pack-block` is what packPrint.css keys `break-inside: avoid`
        // off — a block split across a page boundary is the failure it
        // exists to prevent, and nothing emitted it until now.
        <div key={`${block.kind}-${index}`} data-pack-block className="pack-block">
          <PackBlockView block={block} scale={scale} />
        </div>
      ))}
    </>
  );
}
