/**
 * The twelve pages of the board pack, in order — spec §4.A.
 *
 * This file is a SEQUENCE, not a factory. Every figure, table, chart and
 * caption is built by a model beside it (`packHighlights`, `packScorecard`,
 * `packStatementTables`, `packPageCharts`, `packBasis`, `derivedSentences`);
 * what happens here is choosing which of them lands on which page. Nothing
 * below computes a number, and adding one would put a figure on a board pack
 * that no service owns and `PackFigureProvenance` cannot trace.
 *
 * It is also SYNCHRONOUS, and that is a contract rather than a convenience:
 * every input that needs the database — the figure set, the trend series, the
 * matters, the ledger version — is fetched by the caller and handed in. The
 * document is composed in the same process that renders it (R-P41), so the
 * `TrustedChartSvg` values the charts carry never cross a JSON boundary,
 * where they would silently decay to `string` and lose the compile-time
 * guarantee that only `renderChartSvg` produced them.
 *
 * WHY DERIVED CAPTIONS ARE `disclosure` BLOCKS AND NOT `narrative` ONES.
 * R7 admits two kinds of commentary: approved (a human signed it) and
 * derived (deterministic code). `PackNarrative.status` has neither a
 * 'derived' member nor a renderer for one — `NarrativeColumns` prints a body
 * ONLY when the status is 'approved'. Marking a machine-written caption
 * 'approved' to make it render would put a false claim of human sign-off on
 * every page of the pack, so the derived captions ride in `disclosure`
 * blocks, which have no approval semantics to lie about. The two genuinely
 * human pages — 4 and 11 — carry real `narrative` blocks, and where the
 * commentary has not been approved they carry a 'pending' one, which renders
 * a visible "Commentary pending approval" placeholder rather than dropping
 * the page's requirement or leaking unapproved text.
 */

import { PACK_LABELS } from '@/modules/accounting/services/packs/packSections';
import { formatMoney } from '@/lib/format/money';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type { PackBrand } from '@/modules/accounting/services/packs/packBrand';
import {
  cashTitle,
  highlightsTitle,
  incomeStatementTitle,
  largestMoverCaption,
  narrativeTitle,
  positionTitle,
  resultsTitle,
  scorecardCaption,
  scorecardScore,
  scorecardTitle,
  trendsTitle,
} from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { buildBasis, ROUNDING_FOOTNOTES, ROUNDING_NOTE } from './packBasis';
import { buildHighlightTiles } from './packHighlights';
import { buildScorecardGroups } from './packScorecard';
import {
  buildCashTrendChart,
  buildCashWaterfallChart,
  buildPositionCompositionChart,
  buildProfitWaterfallChart,
  buildTrendPanels,
  TRENDS_PANELS_SPECIFIED,
} from './packPageCharts';
import {
  buildCashTable,
  buildIncomeStatementTable,
  buildPositionTable,
  buildResultsTable,
} from './packStatementTables';
import {
  buildCashBlocks,
  buildHighlightsBlocks,
  buildPositionBlocks,
  buildTrendBlocks,
  commentary,
  disclose,
  note,
} from './packPageBlocks';
import type { PackMatter } from './packMatters';
import type {
  PackFootnote,
  PackNarrative,
  PackPage,
  PackPageBlock,
  PackPagesDocument,
} from './packPageModel';

export interface BoardPackInput {
  /** Page 1's headline — the company's legal name, exempt from the message rule. */
  companyLegalName: string;
  /** Human-readable period, e.g. '1 March 2026 to 31 August 2026'. */
  period: string;
  generatedAt: string;
  draft: boolean;
  preparedBy: string;
  brand: PackBrand;
  set: PackFigureSet;
  trend: PackTrendPoint[];
  matters: PackMatter[];
  /** Page 4's board commentary. Null renders the pending placeholder (R7). */
  commentary: PackNarrative | null;
  /** Page 11's commentary on the matters. Null renders the placeholder. */
  mattersCommentary: PackNarrative | null;
  /** `getLedgerPostedThrough(...)`. Null renders explicit unavailable text (R-P46). */
  ledgerVersion: string | null;
}

const pending: PackNarrative = { status: 'pending', body: null, actions: [] };

function page(
  number: number,
  title: string,
  section: PackPage['section'],
  density: PackPage['density'],
  blocks: PackPageBlock[],
  orientation: PackPage['orientation'] = 'portrait',
  footnotes: PackFootnote[] = [],
): PackPage {
  return { number, title, section, orientation, density, blocks, footnotes };
}

export function buildBoardPackPages(input: BoardPackInput): PackPagesDocument {
  const { set, trend, draft, generatedAt } = input;
  const p = new PackFigureProvenance();
  const basis = buildBasis(set, { draft, generatedAt }, input.ledgerVersion);
  const { scale, currency } = basis.numberConvention;

  const tiles = buildHighlightTiles(set, trend, p);
  const results = buildResultsTable(set, p);
  const income = buildIncomeStatementTable(set, p);
  const position = buildPositionTable(set, p);
  const cash = buildCashTable(set, p);
  const scorecard = buildScorecardGroups(set, p);
  const score = scorecardScore(scorecard);
  const cashBridge = buildCashWaterfallChart(set);
  const cashTrend = buildCashTrendChart(trend);
  const panels = buildTrendPanels(trend);

  // Page 3 — the whole period in one page. Spec §4.A: eight tiles, each with
  // its delta and the basis that delta is measured against.
  const { blocks: highlightBlocks, footnotes: highlightFootnotes } = buildHighlightsBlocks(tiles, scale, currency);
  const highlights = page(3, highlightsTitle(set), 'Performance', 'high', highlightBlocks, 'portrait', highlightFootnotes);

  // Page 5 — the table every later number traces back to, and the five
  // headline tiles beneath it. The tiles are the SAME objects page 3 carries,
  // so the two pages cannot print different values for one figure.
  const snapshot = page(5, resultsTitle(set), 'Financials', 'high', [
    { kind: 'table', table: results },
    { kind: 'kpiTiles', tiles: tiles.slice(0, 5) },
    commentary(largestMoverCaption(results.rows)),
  ], 'portrait', ROUNDING_FOOTNOTES);

  const cashBlocks = buildCashBlocks(cash, cashBridge, cashTrend, set);
  const positionBlocks = buildPositionBlocks(position, buildPositionCompositionChart(set), set);
  const trendBlocks = buildTrendBlocks(panels);

  const matterNotes = input.matters.map((matter) => note(matter.issue, [
    matter.quantum === null ? 'Quantum: not a single amount.' : `Quantum: ${formatMoney(matter.quantum)}.`,
    `Owner: ${matter.owner}.`, `Movement: ${matter.movement}`,
    `Decision required: ${matter.decisionRequired}`,
  ].join(' ')));

  const pages: PackPage[] = [
    page(1, input.companyLegalName, 'Front', 'low', [
      disclose('Confidential — for board use', [
        note('Preparation', `Prepared by ${input.preparedBy} on ${generatedAt.slice(0, 10)}. This pack is ${draft ? 'a DRAFT — figures are not final' : 'FINAL'}.`),
      ]),
    ]),
    page(2, 'Contents', 'Front', 'low', [
      disclose('Basis of preparation', [
        note('In short', `${basis.basisOfPreparation.standard}. ${input.period}. Figures in ${scale} (${currency}), ${draft ? 'draft' : 'final'}. Full basis on page 12.`),
      ]),
    ]),
    highlights,
    // Page 4 — narrative ONLY. Spec §4.A keeps this page free of tabular
    // figures; the commentary and the board's action items are both carried
    // by the one `PackNarrative`, which is what `NarrativeColumns` renders as
    // its two columns.
    page(4, narrativeTitle(set), 'Performance', 'medium', [
      { kind: 'narrative', narrative: input.commentary ?? pending },
    ]),
    snapshot,
    page(6, incomeStatementTitle(set), 'Financials', 'high', [
      { kind: 'table', table: income },
      { kind: 'chart', chart: buildProfitWaterfallChart(set) },
      commentary(largestMoverCaption(income.rows)),
    ], 'portrait', ROUNDING_FOOTNOTES),
    page(7, positionTitle(set), 'Financials', 'high', positionBlocks, 'portrait', ROUNDING_FOOTNOTES),
    page(8, cashTitle(set), 'Financials', 'high', cashBlocks, 'portrait', ROUNDING_FOOTNOTES),
    page(9, scorecardTitle(score.met, score.total), 'Performance', 'high', [
      { kind: 'scorecard', groups: scorecard },
      commentary(scorecardCaption(scorecard)),
      disclose('Scoring basis', [
        note('Targets', 'Targets are the platform defaults; a metric with no target is shown unscored rather than assumed met.'),
        note('Not meaningful', 'A metric shown as not meaningful states its own reason — an unreportable ratio is never printed as a number.'),
      ]),
    ]),
    // The one landscape page in the pack, per spec §4.A page 10 and R5: the
    // orientation is a PAGE-level property the print CSS keys off, never a
    // document-level flag, which would turn the whole pack sideways.
    page(10, trendsTitle(trend, panels.length, TRENDS_PANELS_SPECIFIED), 'Performance', 'high', trendBlocks, 'landscape'),
    page(11, 'Matters requiring board attention', 'Governance', 'medium', [
      disclose('Matters', matterNotes),
      { kind: 'narrative', narrative: input.mattersCommentary ?? pending },
      disclose('What was checked', [
        note('Sources', 'Aged debtor concentration, unreconciled bank items, unusual journals and overdue statutory filings. A source that fails appears as a named matter, never as a silent omission.'),
        note('Movement', 'No prior board pack is stored, so movement since the last meeting is stated as untracked rather than computed from a period comparison, which would answer a different question.'),
      ]),
    ]),
    page(12, 'Basis of preparation and definitions', 'Governance', 'medium', [
      disclose('Basis of preparation', [
        note('Standard', basis.basisOfPreparation.standard),
        note('Period', input.period),
        note('Currency and rounding', `${currency}, figures in ${scale}.`),
        note('Source system', basis.basisOfPreparation.sourceSystem),
        note('Rounding', ROUNDING_NOTE),
        note('Extracted at', basis.basisOfPreparation.extractedAt),
        note('Ledger version', basis.basisOfPreparation.ledgerVersion),
      ]),
      { kind: 'definitions', entries: basis.definitions },
      disclose('Caveats', basis.caveats.length > 0
        ? basis.caveats.map((caveat, index) => note(`Caveat ${index + 1}`, caveat))
        : [note('None', 'No classification or inventory caveat applies to these figures.')]),
    ]),
  ];

  return {
    packType: 'board',
    packLabel: PACK_LABELS.board,
    companyName: input.companyLegalName,
    period: input.period,
    generatedAt,
    draft,
    brand: input.brand,
    numberConvention: basis.numberConvention,
    basisOfPreparation: basis.basisOfPreparation,
    provenance: p,
    pages,
  };
}
