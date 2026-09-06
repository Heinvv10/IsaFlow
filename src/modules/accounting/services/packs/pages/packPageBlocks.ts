/**
 * Block builders for the four board pack pages whose content assembly
 * outgrew a one-line `page(...)` call in `boardPackPages.ts` — page 3
 * (highlights), page 7 (position), page 8 (cash) and page 10 (trends).
 * `boardPackPages.ts` stays a SEQUENCE that says which page gets which
 * blocks; this is where the conditional "which disclosure applies" logic
 * for those four pages lives, alongside `packStatementTables.ts` and
 * `packPageCharts.ts` — the same split, for the same reason: nothing here
 * computes a figure, it only decides how to present ones already built.
 *
 * `note`, `disclose` and `commentary` live here rather than in
 * `boardPackPages.ts` because every block builder below needs them; the
 * sequence file imports them back for its own remaining simple pages.
 */
import {
  cashCaption,
  positionCaption,
  negativeEquitySentence,
  tileCaption,
  trendsCaption,
} from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { TRENDS_PANELS_SPECIFIED, type PackCashBridge } from './packPageCharts';
import { ROUNDING_NOTE } from './packBasis';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type {
  PackChartSpec,
  PackDisclosureNote,
  PackFootnote,
  PackKpiTile,
  PackPageBlock,
  PackTable,
} from './packPageModel';

export const note = (heading: string, body: string): PackDisclosureNote => ({ heading, body });

export const disclose = (heading: string, notes: PackDisclosureNote[]): PackPageBlock => ({
  kind: 'disclosure',
  disclosure: { heading, notes },
});

/**
 * A deterministic caption, carried as a DERIVED narrative — R-P49.
 *
 * It used to ride in a `disclosure` block: `PackNarrative.status` had no
 * 'derived' member and `NarrativeColumns` printed a body only for
 * 'approved', so the only way to make a machine-written caption render was
 * to claim a human had signed it — a false statement on every page of the
 * pack. The status now exists and the renderer LABELS it as derived, so the
 * workaround is gone and the caption says what it is.
 */
export const commentary = (body: string): PackPageBlock => ({
  kind: 'narrative',
  narrative: { status: 'derived', body, actions: [] },
});

/** Page 3's one footnote — spec §4.A page 3's multi-year note under each
 *  tile. Referenced by `PackKpiTile.trendFootnote`, which the tile model
 *  leaves null because the PAGE owns its footnote numbering. */
const SPARKLINE_FOOTNOTE = 1;

/** Page 3 — the whole period in one page. Spec §4.A: eight tiles, each with
 *  its delta and the basis that delta is measured against. */
export function buildHighlightsBlocks(
  tiles: PackKpiTile[],
  scale: string,
  currency: string,
): { blocks: PackPageBlock[]; footnotes: PackFootnote[] } {
  const highlightTiles = tiles.map((tile) =>
    tile.sparklineSvg === null ? tile : { ...tile, trendFootnote: SPARKLINE_FOOTNOTE },
  );
  const sparklineCount = highlightTiles.filter((t) => t.sparklineSvg !== null).length;
  return {
    blocks: [
      { kind: 'kpiTiles', tiles: highlightTiles },
      // One derived line PER TILE, not a restatement of the page title — a
      // commentary block echoing the heading pads the page's density with
      // repetition, which is the opposite of what spec §5.7 asks for.
      disclose('Commentary', highlightTiles.map((tile) => note(tile.label, tileCaption(tile)))),
      disclose('Reading these tiles', [
        note('Comparison basis', 'Each movement is measured against the prior calendar period, stated on the tile itself.'),
        note('Absent comparatives', 'A tile with no movement shown has no comparative period to measure against; it is never shown as a move from zero.'),
        note('Scale', `Figures are in ${scale} (${currency}). ${ROUNDING_NOTE}`),
      ]),
    ],
    footnotes: [{ number: SPARKLINE_FOOTNOTE, text: `Sparklines run over the pack's monthly trend series. ${sparklineCount} of ${highlightTiles.length} tiles carry one; the rest have no monthly series behind them and show none rather than a line drawn from a single point.` }],
  };
}

/** Page 7 — the balance sheet, its composition chart, and the MANDATORY
 *  §3.5 negative-equity disclosure when equity is underwater. */
export function buildPositionBlocks(
  position: PackTable,
  compositionChart: PackChartSpec,
  set: PackFigureSet,
): PackPageBlock[] {
  const positionBlocks: PackPageBlock[] = [
    { kind: 'table', table: position },
    { kind: 'chart', chart: compositionChart },
    commentary(positionCaption(set)),
  ];
  const equity = set.current.totalEquity;
  if (equity < 0) {
    positionBlocks.push(disclose('Negative equity', [
      // One sentence, shared with `NegativeEquityBlock` — a second copy of a
      // MANDATORY §3.5 disclosure is how the two drift apart.
      note('Consequence', negativeEquitySentence(equity)),
    ]));
  }
  return positionBlocks;
}

/** Page 8 — the cash table, the opening→closing bridge (or why there is
 *  none), the closing-cash trend line (or why there is none), and commentary. */
export function buildCashBlocks(
  cash: PackTable,
  cashBridge: PackCashBridge | null,
  cashTrend: PackChartSpec | null,
  set: PackFigureSet,
): PackPageBlock[] {
  const cashBlocks: PackPageBlock[] = [{ kind: 'table', table: cash }];
  if (cashBridge) cashBlocks.push({ kind: 'chart', chart: cashBridge.chart });
  else {
    cashBlocks.push(disclose('No cash bridge', [
      note('Why', 'Opening cash is the prior period\'s closing balance, and there is no prior period. A bridge opening at zero would assert the business started the period with an empty bank account.'),
    ]));
  }
  if (cashTrend) cashBlocks.push({ kind: 'chart', chart: cashTrend });
  else {
    cashBlocks.push(disclose('No closing-cash series', [
      note('Why', 'No monthly trend series covers this period, so no closing-cash line can be drawn.'),
    ]));
  }
  cashBlocks.push(disclose('Commentary', [
    note('This period', cashCaption(set, cashBridge?.residual ?? null)),
  ]));
  return cashBlocks;
}

/** Page 10 — the small multiples (or why none are drawn), commentary, the
 *  shared-scale explanation, and — only when short of spec §4.A's six —
 *  which panels are missing and why. */
export function buildTrendBlocks(panels: PackChartSpec[]): PackPageBlock[] {
  const trendBlocks: PackPageBlock[] = [];
  if (panels.length > 0) trendBlocks.push({ kind: 'smallMultiples', panels });
  else {
    trendBlocks.push(disclose('No trend series', [
      note('Why', 'No monthly series covers this period, so no panel can be drawn. Nothing is inferred from the period totals in its place.'),
    ]));
  }
  trendBlocks.push(commentary(trendsCaption(panels)));
  trendBlocks.push(disclose('Reading these panels', [
    note('Scale', 'Revenue, operating expenses, net profit and cash share one y-scale, so a metric ten times the size of another cannot be mistaken for moving the same amount. Gross margin % and debtor days are different units, so each keeps its own scale.'),
  ]));
  if (panels.length < TRENDS_PANELS_SPECIFIED) {
    trendBlocks.push(disclose('Panels not drawn', [
      note('Why', `Spec §4.A asks for ${TRENDS_PANELS_SPECIFIED} panels and ${panels.length} are drawn. A panel is omitted only when its figure is not meaningful for every period in the window — gross margin % and debtor days both require positive revenue, and no period here had any. Nothing is inferred from the period totals in its place.`),
    ]));
  }
  return trendBlocks;
}
