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
 * HOW COMMENTARY IS LABELLED. R7 admits two kinds: approved (a human signed
 * it) and derived (deterministic code). Both are `narrative` blocks and
 * `PackNarrative.status` says which, so a reader of the printed page can
 * tell them apart — `NarrativeColumns` prints a source label for each. The
 * two genuinely human pages — 4 and 11 — carry an 'approved' narrative, and
 * where the commentary has not been approved they carry a 'pending' one,
 * which renders a visible "Commentary pending approval" placeholder rather
 * than dropping the page's requirement or leaking unapproved text. A
 * 'draft' narrative renders nothing at all.
 */

import { PACK_LABELS } from '@/modules/accounting/services/packs/packSections';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
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
import { buildBasis, statementFootnotes } from './packBasis';
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
  buildCommentaryBlocks,
  buildHighlightsBlocks,
  buildMattersBlock,
  buildPositionBlocks,
  buildTrendBlocks,
  commentary,
  disclose,
  note,
} from './packPageBlocks';
import type { PackMatter } from './packMatters';
import { selectPrintedMatters } from './packMattersPrinted';
import { formatPackPeriod } from './packPeriodLabel';
import {
  buildBasisPage,
  buildFrontPages,
  page,
  type UnnumberedPage,
} from './packFrontMatter';
import { disproportionatePlugSentence } from '@/modules/accounting/services/packs/figures/packWaterfallIntegrity';
import type {
  PackComparativePeriod,
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

/**
 * Page numbers, from position in the sequence.
 *
 * They used to be literals — `page(4, …)`, `page(12, …)`. The sequence is
 * fixed at twelve by spec §4.A (R-P57) and these agree with the spec's own
 * numbering, so nothing about the printed pack changes. What changes is that
 * the contents, the footer and page 2's "full basis on page N" now READ the
 * sequence instead of restating it: the rendered pack printed "Full basis on
 * page 12" while the basis was on sheet 19, and a literal cannot notice.
 */
function numbered(pages: UnnumberedPage[]): PackPage[] {
  return pages.map((p, index) => ({ ...p, number: index + 1 }));
}

export function buildBoardPackPages(input: BoardPackInput): PackPagesDocument {
  const { set, trend, draft, generatedAt } = input;
  const p = new PackFigureProvenance();
  const basis = buildBasis(set, { draft, generatedAt }, input.ledgerVersion);
  const { scale, currency } = basis.numberConvention;

  // The comparative is the window the PRIOR FIGURES were read over, and it
  // exists only where those figures do: `priorWindow` is computed for every
  // pack, but a first-period company has no prior ledger in it (R3), and
  // heading an absent column with a period would claim a comparison this pack
  // does not make. Label and window together, deliberately — see
  // `PackComparativePeriod`, and R-P55.
  const comparativePeriod: PackComparativePeriod | null =
    set.prior === null
      ? null
      : {
          label: formatPackPeriod(set.priorWindow.start, set.priorWindow.end),
          start: set.priorWindow.start,
          end: set.priorWindow.end,
        };
  const statementNotes = statementFootnotes(comparativePeriod);

  const tiles = buildHighlightTiles(set, trend, p);
  const results = buildResultsTable(set, p);
  const income = buildIncomeStatementTable(set, p);
  const position = buildPositionTable(set, p);
  const cash = buildCashTable(set, p);
  const scorecard = buildScorecardGroups(set, p);
  const score = scorecardScore(scorecard);
  const cashBridge = buildCashWaterfallChart(set, scale);
  const cashTrend = buildCashTrendChart(trend, scale);
  const panels = buildTrendPanels(trend, scale);

  // ONE selection of the matters, read by page 4's action panel and page 11's
  // table alike. Derived twice, the two pages contradicted each other about
  // the board's own action list — see `SelectedMatters`.
  const matters = selectPrintedMatters(input.matters);

  // Page 3 — the whole period in one page. Spec §4.A: eight tiles, each with
  // its delta and the basis that delta is measured against.
  const { blocks: highlightBlocks, footnotes: highlightFootnotes } = buildHighlightsBlocks(tiles, scale, currency);
  const highlights = page(highlightsTitle(set, scale), 'Highlights', 'Performance', 'high', highlightBlocks, 'portrait', highlightFootnotes);

  // Page 5 — the table every later number traces back to, and the five
  // headline tiles beneath it. The tiles are the SAME objects page 3 carries,
  // so the two pages cannot print different values for one figure.
  const snapshot = page(resultsTitle(set, scale), 'Group results', 'Financials', 'high', [
    { kind: 'table', table: results },
    { kind: 'kpiTiles', tiles: tiles.slice(0, 5) },
    commentary(largestMoverCaption(results.rows)),
  ], 'portrait', statementNotes);

  // The profit bridge reaches net profit through a step nothing measured —
  // interest and tax, which no field carries. Where that step is a material
  // share of the figure the bridge lands on, the page must say so, and the
  // integrity gate refuses a pack that draws it silently.
  const profitBridge = buildProfitWaterfallChart(set, scale);
  const profitPlug = disproportionatePlugSentence(profitBridge, scale);
  const profitBridgeCaveat: PackPageBlock[] = profitPlug === null
    ? []
    : [disclose('How much of this bridge is unexplained', [
        note('Size of the unexplained step', profitPlug),
      ])];

  const cashBlocks = buildCashBlocks(cash, cashBridge, cashTrend, set, scale);
  const positionBlocks = buildPositionBlocks(position, buildPositionCompositionChart(set, scale), set, scale);
  const trendBlocks = buildTrendBlocks(panels);

  // Page 4 — no tabular figures. Spec §4.A keeps this page free of them; both
  // of its columns are prose.
  //
  // TWO COLUMNS, AND THE SECOND ONE IS WHY THE PAGE IS NOT NEARLY EMPTY.
  // Nothing in this codebase stores board commentary yet, so the left column
  // is the visible "Commentary pending approval." placeholder on every pack
  // today — and the page was built as commentary-ONLY, so that single italic
  // line was the whole sheet at 1.0% fill. §4.A specifies an action panel
  // beside it and it was simply never populated. Filled from the same matters
  // model page 11 tabulates, the page carries content whether or not
  // commentary is approved, so the pack is TWELVE pages either way (R-P57)
  // rather than changing shape according to an editorial state — a director
  // comparing two months' packs must not see the structure move.
  //
  // The placeholder STAYS. Filling the panel is not a way to stop saying that
  // commentary is owed and unwritten.
  const narrativePage = page(
    narrativeTitle(set, scale),
    'Commentary and actions',
    'Performance',
    'medium',
    buildCommentaryBlocks(input.commentary ?? pending, matters),
  );

  const body: UnnumberedPage[] = [
    highlights,
    narrativePage,
    snapshot,
    page(incomeStatementTitle(set, scale), 'Income statement', 'Financials', 'high', [
      { kind: 'table', table: income },
      { kind: 'chart', chart: profitBridge },
      commentary(largestMoverCaption(income.rows)),
      ...profitBridgeCaveat,
    ], 'portrait', statementNotes),
    page(positionTitle(set, scale), 'Balance sheet', 'Financials', 'high', positionBlocks, 'portrait', statementNotes),
    page(cashTitle(set, scale), 'Cash', 'Financials', 'high', cashBlocks, 'portrait', statementNotes),
    page(scorecardTitle(score.met, score.total), 'Scorecard', 'Performance', 'high', [
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
    page(trendsTitle(trend, panels.length, TRENDS_PANELS_SPECIFIED), 'Trends', 'Performance', 'high', trendBlocks, 'landscape'),
    page('Matters requiring board attention', 'Matters for the board', 'Governance', 'medium', [
      // Spec §4.A page 11 asks for a TABLE — issue, quantum, owner, movement,
      // decision required. Prose notes carried the same five facts but a
      // director scanning for "which of these needs me" had to read every
      // paragraph to find the owner column.
      buildMattersBlock(matters, p),
      { kind: 'narrative', narrative: input.mattersCommentary ?? pending },
      disclose('What was checked', [
        note('Sources', 'Aged debtor concentration, unreconciled bank items, unusual journals and overdue statutory filings. A source that fails appears as a named matter, never as a silent omission.'),
        note('Movement', 'No prior board pack is stored, so movement since the last meeting is stated as untracked rather than computed from a period comparison, which would answer a different question.'),
      ]),
    ]),
    buildBasisPage(basis, input.period, comparativePeriod, scale, currency),
  ];

  // Page 2 says where the full basis is; it is the LAST page, counted rather
  // than written as the literal 12 it used to be.
  const total = 2 + body.length;
  const pages = numbered([
    ...buildFrontPages({
      companyLegalName: input.companyLegalName,
      period: input.period,
      preparedBy: input.preparedBy,
      generatedAt,
      draft,
      scale,
      currency,
      basis,
      basisPageNumber: total,
    }),
    ...body,
  ]);

  const document: PackPagesDocument = {
    packType: 'board',
    packLabel: PACK_LABELS.board,
    companyName: input.companyLegalName,
    period: input.period,
    generatedAt,
    draft,
    brand: input.brand,
    numberConvention: basis.numberConvention,
    basisOfPreparation: basis.basisOfPreparation,
    comparativePeriod,
    provenance: p,
    pages,
  };

  // Spec §7.2, and the last thing this function does: a pack whose figures do
  // not reconcile never becomes a document. The gate THROWS rather than
  // warning, because a warning on a pack a director forwards to their bank is
  // a warning nobody reads. Every caller of this function inherits it, which
  // is the only way the check cannot be forgotten at one call site.
  assertPackIntegrity(document);
  return document;
}
