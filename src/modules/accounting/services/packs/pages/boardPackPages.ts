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
 * every input that needs the database is fetched by the caller and handed in,
 * so the `TrustedChartSvg` values the charts carry never cross a JSON
 * boundary, where they would decay to `string` and lose the compile-time
 * guarantee that only `renderChartSvg` produced them (R-P41).
 *
 * HOW COMMENTARY IS LABELLED. R7 admits two kinds: approved (a human signed
 * it) and derived (deterministic code). Both are `narrative` blocks and
 * `PackNarrative.status` says which — `NarrativeColumns` prints a source
 * label for each. The two genuinely human pages, 4 and 11, carry an
 * 'approved' narrative, and where nothing has been approved they carry a
 * 'pending' one, which renders a visible placeholder rather than dropping the
 * page's requirement or leaking unapproved text.
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
  bridgeSignFootnote,
  buildCommentaryBlocks,
  buildHighlightsBlocks,
  buildPositionBlocks,
  buildTrendBlocks,
  commentary,
  disclose,
  mustDisclose,
  note,
} from './packPageBlocks';
import type { PackMatter } from './packMatters';
import { selectPrintedMatters } from './packMattersPrinted';
import { fitPageToBox } from './packPageFit';
import {
  buildMattersBlock,
  buildMattersSupportBlocks,
  mattersBudgetMm,
  mattersTitle,
  MATTERS_NAV_LABEL,
} from './packMattersPage';
// Debtor days printed 213 on the scorecard page and 63.7 on the trends
// page, one sheet apart, with nothing on either saying that one is the
// period and the other a month.
import { periodWindowFootnotes } from './packTrendCrossReference';
import { formatPackPeriod } from './packPeriodLabel';
import {
  buildBasisPage,
  buildFrontPages,
  numbered,
  page,
  type UnnumberedPage,
} from './packFrontMatter';
import { disproportionatePlugSentence } from '@/modules/accounting/services/packs/figures/packWaterfallIntegrity';
import type { PackDraftReason } from './packDraftStatus';
import type {
  PackComparativePeriod,
  PackNarrative,
  PackPageBlock,
  PackPagesDocument,
} from './packPageModel';

export interface BoardPackInput {
  /** Page 1's headline — the company's legal name, exempt from the message rule. */
  companyLegalName: string;
  /** Human-readable period, e.g. '1 March 2026 to 31 August 2026'. */
  period: string;
  generatedAt: string;
  /**
   * Every reason this pack is not final, from `draftReasons(...)`. Empty
   * means final.
   *
   * NOT a boolean. "The fiscal period is closed" and "a human approved the
   * commentary" are two facts, and one flag carrying both is how the
   * Brightsphere pack — no approved commentary, inverted colours, three panel
   * titles reading "rose from – to –" — told a board it was FINAL while the
   * demo pack, from the same command on the same day, said DRAFT.
   */
  draftReasons: PackDraftReason[];
  preparedBy: string;
  brand: PackBrand;
  set: PackFigureSet;
  trend: PackTrendPoint[];
  matters: PackMatter[];
  /** Page 4's board commentary. Null renders the pending placeholder (R7),
   *  and is also one of the two things that keep a pack a DRAFT — see
   *  `draftReasons`. */
  commentary: PackNarrative | null;
  /** Page 11's commentary on the matters. Null renders the placeholder. */
  mattersCommentary: PackNarrative | null;
  /** `getLedgerPostedThrough(...)`. Null renders explicit unavailable text (R-P46). */
  ledgerVersion: string | null;
}

const pending: PackNarrative = { status: 'pending', body: null, actions: [] };

export function buildBoardPackPages(input: BoardPackInput): PackPagesDocument {
  const { set, trend, generatedAt } = input;
  const draft = input.draftReasons.length > 0;
  const p = new PackFigureProvenance();
  const basis = buildBasis(set, { generatedAt }, input.draftReasons, input.ledgerVersion, p);
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
  const trendPanels = buildTrendPanels(trend, scale);
  // The panels themselves, for every reader that only needs the drawn list —
  // the page's cross-reference footnotes and the title's count. The scale
  // SPLIT (which of them share a y-domain) is read by `buildTrendBlocks`
  // alone, off the one decision `buildTrendPanels` made.
  const panels = trendPanels.panels;
  // PAGE 11'S OWN BLOCKS, BEFORE ITS TABLE — because the table's budget is
  // whatever they leave behind. ONE selection, read by page 4's panel and
  // page 11's table alike: derived twice, they contradicted each other. See
  // `SelectedMatters` and `mattersBudgetMm`.
  const mattersSupport = buildMattersSupportBlocks(input.mattersCommentary ?? pending);
  // The title first, from the FULL list: the budget the table spends depends
  // on how much paper the header leaves, and the headline must not change
  // when a row moves off the page.
  const mattersHeadline = mattersTitle(input.matters, scale);
  const matters = selectPrintedMatters(input.matters, mattersBudgetMm(mattersSupport, mattersHeadline));

  // Page 3 — the whole period in one page. Spec §4.A: eight tiles, each with
  // its delta and the basis that delta is measured against.
  const { blocks: highlightBlocks, footnotes: highlightFootnotes } = buildHighlightsBlocks(tiles, scale, currency, comparativePeriod);
  const highlights = page(highlightsTitle(set, scale), 'Highlights', 'Performance', 'high', highlightBlocks, 'portrait', highlightFootnotes);

  // Page 5 — the table every later number traces back to.
  //
  // IT NO LONGER REPEATS PAGE 3'S TILES. It carried `tiles.slice(0, 5)` —
  // literally the same five objects page 3 draws, in the same component, with
  // the same sparklines, two sheets later and with nothing added on the second
  // showing. Two pages printing one component twice is the signature of an
  // assembled deck rather than a designed document, and it was doing no work:
  // four of the five figures appear again in this page's own table three
  // centimetres above, there with a comparative, a change and a change
  // percentage the tiles cannot carry.
  //
  // So the two pages now have one job each. Page 3 is the tile page — the
  // period in eight figures, each with its basis and its trend. Page 5 is the
  // statement page — the same figures as a table a director can foot, against
  // the prior period. Neither is a version of the other.
  //
  // WHAT PAGE 5 GAINS IN THE ROOM. Its table is the only one in the pack that
  // prints a NON-IFRS measure — EBITDA, between operating profit and net
  // profit — and a non-IFRS measure has to be identified as one where it is
  // PRESENTED, not only where it happens to be defined. The reconciliation
  // itself stays on page 12 with the other definitions, in figures a reader
  // can add up; this says which row needs it and where to find it.
  const snapshot = page(resultsTitle(set, scale), 'Group results', 'Financials', 'high', [
    { kind: 'table', table: results },
    mustDisclose('Non-IFRS measures in this table', [
      note('EBITDA', 'Every other row of this table is an IFRS line. EBITDA is not: it is '
        + 'operating profit plus the depreciation and amortisation charged in the period, and it '
        + 'is presented because a board asks for it, not because a standard requires it. The '
        + 'basis of preparation reconciles it to operating profit line by line.'),
    ]),
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
    : [mustDisclose('How much of this bridge is unexplained', [note('Size of the unexplained step', profitPlug)])];

  // The bridge labels a cost line the opposite way the table does, and both
  // are right — see `bridgeSignFootnote`. Printed only where a line actually
  // diverges, and it names that line, so the next footnote's number depends
  // on whether this one is there.
  const bridgeNote = bridgeSignFootnote(income, profitBridge, scale, statementNotes.length + 1);

  const cashBlocks = buildCashBlocks(cash, cashBridge, cashTrend, set, scale);
  const positionBlocks = buildPositionBlocks(position, buildPositionCompositionChart(set, scale), set, scale);
  const trendBlocks = buildTrendBlocks(trendPanels);

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
      // The reciprocal of the trends page's own window note rides in this
      // page's FOOTNOTES, below — see `periodWindowFootnotes`.
    ], 'portrait', [
      ...statementNotes,
      ...bridgeNote,
      ...periodWindowFootnotes(panels, 'trend-gross-margin', 'Income statement', statementNotes.length + bridgeNote.length + 1),
    ]),
    page(positionTitle(set, scale), 'Balance sheet', 'Financials', 'high', positionBlocks, 'portrait', statementNotes),
    page(cashTitle(set, scale), 'Cash', 'Financials', 'high', cashBlocks, 'portrait', statementNotes),
    page(scorecardTitle(score.met, score.total), 'Scorecard', 'Performance', 'high', [
      { kind: 'scorecard', groups: scorecard },
      commentary(scorecardCaption(scorecard)),
      // ONE note, not two. "Targets" and "Not meaningful" were definitions,
      // and they now sit with the other sixteen on the basis page — this page
      // could not afford them, dropped both for space and then printed "2
      // explanatory notes are not printed", telling a director that two
      // measures had lost their explanation without saying which. What stays
      // is the POINTER, because a director reading a column of MISSED and
      // NOT MEANINGFUL needs to know both are defined and where.
      disclose('Scoring basis', [
        note('Definitions', 'Each metric is scored against the platform\'s default target. The basis page defines the terms and every formula used here.'),
      ]),
    ], 'portrait', periodWindowFootnotes(panels, 'trend-debtor-days', 'Scorecard', 1)),
    // PORTRAIT, like the other eleven. This was the one landscape sheet in
    // the pack — six panels three across needed the width — and printed and
    // bound it was the sheet a director had to turn. Two across at 83mm fits
    // the portrait measure, and the 255mm box gives each panel 48mm instead
    // of 36. Orientation stays a PAGE-level property (R5): the capability is
    // unchanged, no page asks for it.
    page(trendsTitle(trend, panels.length, TRENDS_PANELS_SPECIFIED), 'Trends', 'Performance', 'high', trendBlocks),
    page(mattersHeadline, MATTERS_NAV_LABEL, 'Governance', 'medium', [
      // Spec §4.A page 11 asks for a TABLE — issue, quantum, owner, movement,
      // decision required. Prose notes carried the same five facts but a
      // director scanning for "which of these needs me" had to read every
      // paragraph to find the owner column.
      buildMattersBlock(matters, p),
      ...mattersSupport,
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
      draftReasons: input.draftReasons,
      scale,
      currency,
      basis,
      basisPageNumber: total,
    }),
    // EVERY page, held to its sheet — the same rule the matters table spends
    // its budget under, applied to the prose on the other eleven. A page that
    // already fits comes back untouched.
    ...body.map(fitPageToBox),
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
