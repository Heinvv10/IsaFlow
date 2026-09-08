/**
 * The board pack document across a JSON boundary, in both directions.
 *
 * WHY A BOUNDARY EXISTS AT ALL. `buildBoardPackPages` composes the twelve
 * pages synchronously and its charts are rendered by `renderChartSvg`, which
 * needs `node:crypto` and ECharts — and `next.config.js` sets `crypto: false`
 * in the client webpack fallback, so it CANNOT run in a browser. The printed
 * page is a browser page. Composing server-side and serialising is therefore
 * not a preference; it is the only reachable architecture, and R-P41's
 * original "same process" guarantee is retired with this file rather than
 * quietly broken.
 *
 * WHAT THE BOUNDARY COSTS, AND WHAT PAYS IT BACK. `TrustedChartSvg` is a
 * compile-time brand: it does not survive `JSON.parse`, and a value that
 * merely looks branded on the far side has been through neither guard. Every
 * SVG-bearing field is therefore re-branded here by `adoptTrustedChartSvg`,
 * which re-runs `assertNoExternalReferences` and `assertStyleBlockIsOurs`.
 * There is no `as TrustedChartSvg` cast in this file, and there must never
 * be one: a cast here would silently reopen the `dangerouslySetInnerHTML`
 * sink that the brand exists to guard.
 *
 * THE BLOCK SWITCH IS ALSO A VALIDATOR. `PackBlocks.tsx` used to be able to
 * say a block kind is only ever constructed in-process; it is now parsed from
 * JSON, so `adoptBlock` refuses a kind it does not know rather than letting an
 * unrenderable block reach the exhaustive switch in the component tree.
 *
 * WHAT IS NOT PRESERVED: object identity. `PackFigureProvenance` hands back
 * the frozen figure object it recorded so a page cannot render one value and
 * record another — an identity no serialisation can carry. The provenance is
 * REPLAYED through `figure()` on the far side, so its own validations run
 * again and `assertConsistent()` still answers correctly on equal values;
 * what is gone is the guarantee that the page's figure and the recorded one
 * are the same object. The composing process still has it, which is where the
 * pages are built and where that guarantee does its work.
 */

import { adoptTrustedChartSvg, type TrustedChartSvg } from '@/lib/charts/trustedChartSvg';
import { toMoneyScale } from '@/lib/format/money';
import {
  PackFigureProvenance,
  type PackFigure,
} from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type {
  PackChartSpec,
  PackKpiTile,
  PackPage,
  PackPageBlock,
  PackPagesDocument,
  PackScorecardGroup,
  PackScorecardRow,
} from './packPageModel';

/**
 * `T` with every `TrustedChartSvg` widened back to the plain `string` that
 * actually crosses the wire.
 *
 * Derived from the model rather than hand-written as a parallel set of
 * interfaces, deliberately: a hand-written wire type is a second copy of the
 * page model that drifts the first time a field is added, and the drift shows
 * up as a field silently missing from a printed pack.
 *
 * An array keeps the mutability it had — `PackTable.columns` is
 * `readonly PackTableColumnKey[]`, and mapping it to a mutable array breaks
 * the SERIALISE direction (a readonly array is not assignable to a mutable
 * one). Both directions have to compile: this type describes one wire shape
 * used by a writer and a reader.
 */
export type Unbranded<T> =
  T extends TrustedChartSvg ? string
    : T extends readonly (infer U)[]
      ? (T extends U[] ? Unbranded<U>[] : readonly Unbranded<U>[])
      : T extends object ? { [K in keyof T]: Unbranded<T[K]> }
        : T;

/**
 * The wire shape. `provenance` is the one field that is not merely unbranded:
 * `PackFigureProvenance` is a class holding a `Map`, and `JSON.stringify` of
 * either is `{}` — a document that serialised its provenance as an empty
 * object would claim a traceability record it does not have.
 */
export type SerialisedPackPagesDocument =
  Unbranded<Omit<PackPagesDocument, 'provenance'>> & {
    /** Every figure issued while composing, flat and in issue order. The
     *  grouping `PackFigureProvenance` keys by is `figure.source`, which each
     *  entry already carries, so a grouped wire shape would be redundant. */
    provenance: PackFigure[];
  };

export function serialisePackPagesDocument(
  document: PackPagesDocument,
): SerialisedPackPagesDocument {
  const { provenance, ...rest } = document;
  return {
    ...rest,
    provenance: [...provenance.all().values()].flat(),
  };
}

function adoptChart(chart: Unbranded<PackChartSpec>): PackChartSpec {
  return { ...chart, svg: adoptTrustedChartSvg(chart.svg) };
}

/** A nullable SVG field. `null` is a real, documented state (no series to
 *  draw); anything else — including a MISSING field, which arrives as
 *  `undefined` — goes through the guards and is refused if it is not markup
 *  we produced. */
function adoptNullableSvg(value: string | null): TrustedChartSvg | null {
  return value === null ? null : adoptTrustedChartSvg(value);
}

function adoptTile(tile: Unbranded<PackKpiTile>): PackKpiTile {
  return { ...tile, sparklineSvg: adoptNullableSvg(tile.sparklineSvg) };
}

function adoptScorecardRow(row: Unbranded<PackScorecardRow>): PackScorecardRow {
  return {
    ...row,
    trendSvg: adoptNullableSvg(row.trendSvg),
    bulletSvg: adoptNullableSvg(row.bulletSvg),
  };
}

function adoptScorecardGroup(group: Unbranded<PackScorecardGroup>): PackScorecardGroup {
  return { ...group, rows: group.rows.map(adoptScorecardRow) };
}

function adoptBlock(block: Unbranded<PackPageBlock>): PackPageBlock {
  switch (block.kind) {
    case 'chart':
      return { kind: 'chart', chart: adoptChart(block.chart) };
    case 'smallMultiples':
      return { kind: 'smallMultiples', panels: block.panels.map(adoptChart) };
    case 'kpiTiles':
      return { kind: 'kpiTiles', tiles: block.tiles.map(adoptTile) };
    case 'scorecard':
      return {
        kind: 'scorecard',
        groups: block.groups.map(adoptScorecardGroup),
        // The PRIOR heading's footnote number. Carried across explicitly like
        // every other field on this boundary — the switch here is the runtime
        // validator the component tree no longer has, so a field it drops is a
        // marker that silently stops printing.
        priorFootnote: block.priorFootnote ?? null,
      };
    // Every remaining kind carries no `TrustedChartSvg` field, so it crosses
    // the wire unchanged. Listed one by one rather than caught by a `default`
    // so that a new SVG-bearing block kind is a COMPILE ERROR here instead of
    // slipping through unadopted — which is the exact hole this file exists
    // to close.
    case 'table':
    case 'statTiles':
    case 'narrative':
    case 'matters':
    case 'disclosure':
    case 'definitions':
      return block;
    default: {
      const unknownKind: never = block;
      throw new Error(
        `adoptPackPagesDocument: refusing an unknown block kind ` +
          `${JSON.stringify((unknownKind as { kind?: unknown }).kind)}`,
      );
    }
  }
}

function adoptPage(page: Unbranded<PackPage>): PackPage {
  return { ...page, blocks: page.blocks.map(adoptBlock) };
}

/** Replayed through `figure()`, not reconstructed around it: the source, the
 *  value/reason exclusivity and the finiteness checks all run again on the
 *  far side, so a payload carrying a figure the composer could not have
 *  issued is refused rather than recorded. */
function replayProvenance(figures: PackFigure[]): PackFigureProvenance {
  const provenance = new PackFigureProvenance();
  for (const figure of figures) {
    provenance.figure(figure.source, figure.value, figure.format, figure.unavailable, figure.basis);
  }
  return provenance;
}

/**
 * The ONLY way a deserialised board pack becomes a `PackPagesDocument`.
 *
 * Throws — it does not degrade. `usePrintReady` has deliberately no timeout,
 * so a pack that renders with a hole in it is worse than one that never
 * becomes print-ready: the renderer fails loudly and nothing reaches a
 * director.
 */
export function adoptPackPagesDocument(raw: SerialisedPackPagesDocument): PackPagesDocument {
  const { provenance, pages, numberConvention, ...rest } = raw;

  // `PackNumberConvention.scale` is typed `MoneyScale`, and a type guarantee
  // does not survive `JSON.parse` — the same reason every SVG is re-branded
  // above. Re-narrowed rather than trusted: every figure on the pack is
  // FORMATTED at this scale, so an unrecognised one would print rands under
  // a header claiming thousands (R-P52).
  const scale = toMoneyScale(numberConvention.scale);
  if (scale === null) {
    throw new Error(
      `adoptPackPagesDocument: the pack states its figures in ` +
        `'${numberConvention.scale}', which is not a scale any formatter knows. ` +
        `Refusing to print figures at an unknown scale.`,
    );
  }

  return {
    ...rest,
    numberConvention: { ...numberConvention, scale },
    pages: pages.map(adoptPage),
    provenance: replayProvenance(provenance),
  };
}
