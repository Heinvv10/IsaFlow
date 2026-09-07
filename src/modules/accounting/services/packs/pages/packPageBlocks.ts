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
  boardActionItems,
  cashCaption,
  positionCaption,
  negativeEquitySentence,
  tileCaption,
  trendsCaption,
} from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { TRENDS_PANELS_SPECIFIED, type PackCashBridge } from './packPageCharts';
import type { MoneyScale } from '@/lib/format/money';
import { disproportionatePlugSentence } from '@/modules/accounting/services/packs/figures/packWaterfallIntegrity';
import { ROUNDING_NOTE } from './packBasis';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackMatter } from './packMatters';
import { omittedQuantum, type SelectedMatters } from './packMattersPrinted';
import type {
  PackChartSpec,
  PackDisclosureNote,
  PackFootnote,
  PackKpiTile,
  PackNarrative,
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
  scale: MoneyScale,
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

/**
 * Page 4 — spec §4.A's two prose columns, and the note that says where each
 * of them comes from.
 *
 * NO TABULAR FIGURES, per §4.A: a narrative block and a disclosure block,
 * both prose. The action panel is DERIVED from the same matters the matters
 * page tabulates, so it is populated whether or not a human has approved
 * commentary — which is what keeps this page from being the one italic line
 * at 1.0% fill that shipped in the first rendered pack (R-P57).
 *
 * The note is not padding. A director reading a pack whose commentary column
 * says "pending approval" needs to know that this is a state of the pack and
 * not a rendering fault, and that the panel beside it was not written by the
 * person who will sign the commentary.
 */
export function buildCommentaryBlocks(
  narrative: PackNarrative,
  selection: SelectedMatters,
): PackPageBlock[] {
  return [
    { kind: 'narrative', narrative, boardActions: boardActionItems(selection) },
    disclose('How this page is prepared', [
      note('Commentary', 'The left column carries the board\'s own commentary on the period. It prints only once an approver has signed it; until then this page says so rather than printing unapproved text.'),
      note('Action panel', 'The right column is derived from the same checks the matters page tabulates — aged debtor concentration, unreconciled bank items, unusual journals and overdue statutory filings — ordered by the size of the exposure. It is machine-written and states the decision each matter is waiting on, never a recommendation.'),
    ]),
  ];
}

/**
 * Page 11 — the matters, with each quantum recorded through the provenance
 * map (I-4).
 *
 * The source is indexed by RANK, which is the only stable identifier a matter
 * has: `buildMatters` orders them by quantum, largest first, and two matters
 * from different sources can carry the same issue text. It must be unique per
 * matter — one source issued twice with two values is what `assertConsistent`
 * throws on, and it would take the render with it.
 */
const NO_QUANTUM =
  'This matter has no single rand amount — an overdue filing, or a check that found nothing to quantify.';

const OMITTED_NOT_QUANTIFIED =
  'None of the matters not printed here carries a single rand amount, so they have no total to state.';

export function buildMattersBlock(selection: SelectedMatters, p: PackFigureProvenance): PackPageBlock {
  // What FITS on the sheet, and what is left over — see `packMattersPrinted`.
  // The selection is made ONCE, by `buildBoardPackPages`, and page 4's action
  // panel is handed the same object: the two pages cannot disagree about the
  // board's action list because there is only one list.
  //
  // The index a quantum is recorded under is the matter's rank in the FULL
  // list as `buildMatters` returned it — `selection.source`, not the printing
  // order — so a source is still unique per matter and still traces back to
  // the same finding whether or not the page had room to print it, and it
  // does not move when the printing order does.
  const { printed, omitted, source } = selection;
  const rank = new Map<PackMatter, number>(source.map((matter, index) => [matter, index]));
  const total = omittedQuantum(omitted);

  return {
    kind: 'matters',
    matters: printed.map((matter) => {
      const { quantum, ...rest } = matter;
      const source = `buildMatters.quantum.${rank.get(matter) ?? 0}`;
      return {
        ...rest,
        quantum: quantum === null
          ? p.figure(source, null, 'money', NO_QUANTUM)
          : p.figure(source, quantum, 'money'),
      };
    }),
    omitted: omitted.length === 0 ? null : {
      count: omitted.length,
      quantum: total === null
        ? p.figure('buildMatters.omittedQuantum', null, 'money', OMITTED_NOT_QUANTIFIED)
        : p.figure('buildMatters.omittedQuantum', total, 'money'),
    },
  };
}

/** Page 7 — the balance sheet, its composition chart, and the MANDATORY
 *  §3.5 negative-equity disclosure when equity is underwater. */
export function buildPositionBlocks(
  position: PackTable,
  compositionChart: PackChartSpec,
  set: PackFigureSet,
  scale: MoneyScale,
): PackPageBlock[] {
  const positionBlocks: PackPageBlock[] = [
    { kind: 'table', table: position },
    { kind: 'chart', chart: compositionChart },
    commentary(positionCaption(set, scale)),
  ];
  const equity = set.current.totalEquity;
  if (equity < 0) {
    positionBlocks.push(disclose('Negative equity', [
      // One sentence, shared with `NegativeEquityBlock` — a second copy of a
      // MANDATORY §3.5 disclosure is how the two drift apart.
      note('Consequence', negativeEquitySentence(equity, scale)),
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
  scale: MoneyScale,
): PackPageBlock[] {
  const cashBlocks: PackPageBlock[] = [{ kind: 'table', table: cash }];
  if (cashBridge) {
    cashBlocks.push({ kind: 'chart', chart: cashBridge.chart });
    // The bridge foots on a named plug, which is honest — but on these
    // figures the plug is larger than the net movement it sits inside, and a
    // bar that dwarfs its own subject needs saying out loud rather than
    // merely labelling. The gate requires this sentence whenever the share
    // breaches; the sentence itself is defined once, beside the check.
    const disproportionate = disproportionatePlugSentence(cashBridge.chart, scale);
    if (disproportionate !== null) {
      cashBlocks.push(disclose('How much of this bridge is unexplained', [
        note('Size of the unexplained step', disproportionate),
      ]));
    }
  }
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
    note('This period', cashCaption(set, cashBridge?.residual ?? null, scale)),
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
