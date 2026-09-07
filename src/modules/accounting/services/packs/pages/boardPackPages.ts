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
  negativeRevenueSentence,
  positionTitle,
  scorecardCaption,
  scorecardScore,
  scorecardTitle,
  trendsTitle,
} from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { buildBasis, ROUNDING_FOOTNOTES, statementFootnotes } from './packBasis';
import { buildHighlightTiles } from './packHighlights';
import { buildScorecardGroups } from './packScorecard';
import {
  buildCashTrendChart,
  shorterCashTrendChart,
  buildCashWaterfallChart,
  buildPositionCompositionChart,
  buildProfitWaterfallChart,
  buildTrendPanels,
  shorterProfitBridge,
  TRENDS_PANELS_SPECIFIED,
} from './packPageCharts';
import {
  buildCashTable,
  buildIncomeStatementTable,
  buildPositionTable,
} from './packStatementTables';
import {
  buildMonthlyResultsTable,
  ebitdaMemoSentence,
  monthlyResultsCaption,
  monthlyResultsTitle,
  trendWindowLabel,
} from './packMonthlyResults';
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
import { withDerivedMatters } from './packDerivedMatters';
import { partialMonthClauseFor } from './packPartialMonth';
import { selectPrintedMatters } from './packMattersPrinted';
import { fitPageToBox } from './packPageFit';
import { pageBoxMm, pageMm } from './packPageMetrics';
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
import { cashWindowFootnotes, periodWindowFootnotes } from './packTrendCrossReference';
import { formatPackPeriod } from './packPeriodLabel';
import {
  buildBasisPage,
  fitBasisPage,
  buildFrontPages,
  numbered,
  page,
  type UnnumberedPage,
} from './packFrontMatter';
import { disproportionatePlugSentence } from '@/modules/accounting/services/packs/figures/packWaterfallIntegrity';
import type { PackDraftReason } from './packDraftStatus';
import type {
  PackChartSpec,
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
  const basis = buildBasis(set, { generatedAt }, input.draftReasons, input.ledgerVersion, trend, p);
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
  const monthlyResults = buildMonthlyResultsTable(trend, p);
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
  // The checks that reach this page all read the ledger; one anomaly is
  // visible only in the SERIES — see `creditMonthMatters`.
  const allMatters = withDerivedMatters(input.matters, trend, scale);
  const mattersHeadline = mattersTitle(allMatters, scale);
  const matters = selectPrintedMatters(allMatters, mattersBudgetMm(mattersSupport, mattersHeadline));

  // Page 3 — the whole period in one page. Spec §4.A: eight tiles, each with
  // its delta and the basis that delta is measured against.
  const { blocks: highlightBlocks, footnotes: highlightFootnotes } = buildHighlightsBlocks(tiles, scale, currency, comparativePeriod);
  const highlights = page(highlightsTitle(set, scale), 'Highlights', 'Performance', 'high', highlightBlocks, 'portrait', highlightFootnotes);

  // Page 5 — the result month by month. See `packMonthlyResults.ts` for why
  // it is no longer the period statement sheet 6 prints again three
  // centimetres of paper later.
  // THE SERIES BLOCKS ARE WHAT VARIES; the EBITDA memorandum and the caption
  // below are the period's and are on the sheet either way, which is also
  // what keeps a company with no series above the three-block floor.
  const monthlySeriesBlocks: PackPageBlock[] = trend.length === 0
    ? [mustDisclose('No monthly series', [
        note('Why', 'No monthly series covers this period, so the result cannot be shown month by '
          + 'month. Nothing is inferred from the period totals in its place; the income statement '
          + 'overleaf carries them.'),
      ])]
    : [
      { kind: 'table', table: monthlyResults },
      mustDisclose('Reading this table', [
        // WHAT THE BANDS ARE, because two of them are headed by a word the
        // income statement does not use, and a heading set in 7pt caps over a
        // 21mm measure cannot carry the definition itself. Revenue and Other
        // income are the two bands of the income side and are the same two the
        // income statement overleaf prints under those names.
        note('The columns', 'Revenue is turnover; Other income is the band the income statement '
          + 'reports separately. Cost of sales, Operating and Other are the three bands every '
          + 'expense of a month falls into: cost of sales, everything else above the operating '
          + 'line, and everything below it — finance costs, tax and other expenses. The two '
          + 'income columns less the three expense columns are the month\'s net profit, so each '
          + 'row adds across.'),
        // AND WHICH WINDOW THIS IS. The trend runs twelve months to the
        // reporting date and the pack's period is whatever was asked for; the
        // closing row states its own window, and this says why it is not the
        // period total on the next sheet.
        // AND WHICH OF ITS MONTHS IS NOT A WHOLE MONTH. The last row of this
        // table is the month CONTAINING the reporting date, so on a pack run
        // mid-month it is a stub — seven days on the pack the visual gate
        // read — summed into the closing row beside eleven whole months. The
        // row and the closing label carry "(part)"; this says what that
        // means, on the sheet the rows are printed on. Appended to the
        // window note rather than given a note of its own: page 5 has the
        // paper for a clause and not for a block.
        note('The window', `This table covers ${trendWindowLabel(trend)}, which is the series page `
          + '10 draws. The reporting period is stated in the footer of every sheet, and the income '
          + 'statement overleaf carries that period\'s own totals against the comparative.'
          + (partialMonthClauseFor(trend) === null ? '' : ` ${partialMonthClauseFor(trend)}`)),
      ]),
    ];
  const monthlyBlocks: PackPageBlock[] = [
    ...monthlySeriesBlocks,
    // THE PACK'S ONE NON-IFRS MEASURE STAYS ON THIS SHEET — see
    // `ebitdaMemoSentence` for why it is stated rather than tabulated, and
    // why sheet 6 could not take it with the note that has to identify it.
    mustDisclose('The reporting period\'s EBITDA', [
      note('EBITDA', ebitdaMemoSentence(set, scale)),
    ]),
    commentary(monthlyResultsCaption(trend, scale)),
  ];
  const snapshot = page(monthlyResultsTitle(trend, scale), 'Group results', 'Financials', 'high',
    monthlyBlocks, 'portrait', ROUNDING_FOOTNOTES);

  // The profit bridge reaches net profit through a step nothing measured —
  // interest and tax, which no field carries. Where that step is a material
  // share of the figure the bridge lands on, the page must say so, and the
  // integrity gate refuses a pack that draws it silently.
  const negativeRevenueCaveat: PackPageBlock[] = set.current.revenue >= 0
    ? []
    : [mustDisclose('Negative revenue', [
        note('What this means', negativeRevenueSentence(set.current.revenue, scale)),
      ])];

  // The bridge steps down a rung where this page also carries the trends
  // cross-reference footnote — see `buildProfitWaterfallChart`. Derived from
  // the same call that puts the footnote on the page below, so the height and
  // the footnote cannot disagree about whether the panel exists.
  const grossMarginWindowNote = periodWindowFootnotes(panels, 'trend-gross-margin', 'Income statement', 1);

  // PAGE 6, AS A FUNCTION OF THE BRIDGE ON IT, because the height of the
  // bridge is decided by measuring this page rather than by predicting it —
  // see `shorterProfitBridge` and the loop below. Everything here except the
  // chart is the same at every rung; the plug sentence and the sign footnote
  // are rebuilt from the bridge passed in rather than from a bridge built
  // once, so a page cannot describe a chart it is not carrying.
  const incomeStatementSheet = (bridge: PackChartSpec): UnnumberedPage => {
    const profitPlug = disproportionatePlugSentence(bridge, scale);
    const profitBridgeCaveat: PackPageBlock[] = profitPlug === null
      ? []
      : [mustDisclose('How much of this bridge is unexplained', [note('Size of the unexplained step', profitPlug)])];
    // The bridge labels a cost line the opposite way the table does, and both
    // are right — see `bridgeSignFootnote`. Printed only where a line actually
    // diverges, and it names that line, so the next footnote's number depends
    // on whether this one is there.
    const bridgeNote = bridgeSignFootnote(income, bridge, scale, statementNotes.length + 1);
    return page(incomeStatementTitle(set, scale), 'Income statement', 'Financials', 'high', [
      { kind: 'table', table: income },
      { kind: 'chart', chart: bridge },
      commentary(largestMoverCaption(income.rows)),
      // The same treatment page 7 gives negative assets. Brightsphere heads
      // this page with revenue of (5 535) and said nothing about it, two
      // sheets before explaining a negative asset side at length.
      ...negativeRevenueCaveat,
      ...profitBridgeCaveat,
      // The reciprocal of the trends page's own window note rides in this
      // page's FOOTNOTES, below — see `periodWindowFootnotes`.
    ], 'portrait', [
      ...statementNotes,
      ...bridgeNote,
      ...periodWindowFootnotes(panels, 'trend-gross-margin', 'Income statement', statementNotes.length + bridgeNote.length + 1),
    ]);
  };

  // AND THE RUNG IS CHOSEN BY MEASURING THE PAGE, NOT BY PREDICTING IT.
  //
  // Live Brightsphere carries the negative-revenue disclosure, a required
  // sign-flip footnote and a three-line caption saying no percentage change
  // is meaningful, and at the rung the predicates chose the sheet measured
  // 260.5mm in a 255mm box with nothing left on it `fitPageToBox` may drop —
  // so the company could not be given a board pack at all. Nothing on the
  // page is spare: every block carries a figure or a note the pack owes the
  // reader, and the chart is the one thing on it with a height the spec lets
  // us choose.
  //
  // A page that already fits is composed once and keeps the height it has.
  let profitBridge = buildProfitWaterfallChart(set, scale, grossMarginWindowNote.length > 0);
  let incomeSheet = incomeStatementSheet(profitBridge);
  while (pageMm(incomeSheet) > pageBoxMm(incomeSheet)) {
    const shorter = shorterProfitBridge(set, scale, profitBridge);
    if (shorter === null) break;
    profitBridge = shorter;
    incomeSheet = incomeStatementSheet(profitBridge);
  }

  // PAGE 8, AS A FUNCTION OF THE CASH LINE ON IT — the same construction
  // page 6 uses for its bridge, and for the same reason: the height of the
  // one chart the spec lets us choose is decided by measuring the composed
  // sheet, not by a constant chosen against one company's data.
  const cashSheet = (line: PackChartSpec | null): UnnumberedPage =>
    // The cash page is the one sheet carrying BOTH windows — the table's
    // period opening balance and the twelve-month line beneath it — and it
    // was the one page with no note saying so. See `cashWindowFootnotes`.
    page(cashTitle(set, scale), 'Cash', 'Financials', 'high',
      buildCashBlocks(cash, cashBridge, line, set, scale), 'portrait', [
        ...statementNotes,
        ...cashWindowFootnotes(trend, line !== null, statementNotes.length + 1),
      ]);

  let cashLine = cashTrend;
  let cashPage = cashSheet(cashLine);
  while (cashLine !== null && pageMm(cashPage) > pageBoxMm(cashPage)) {
    const shorter = shorterCashTrendChart(trend, scale, cashLine);
    if (shorter === null) break;
    cashLine = shorter;
    cashPage = cashSheet(cashLine);
  }

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
    incomeSheet,
    page(positionTitle(set, scale), 'Balance sheet', 'Financials', 'high', positionBlocks, 'portrait', statementNotes),
    cashPage,
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
      // OPTIONAL, AND MEASURED RATHER THAN ASSUMED. On the live demo company
      // this page measures 255.05mm against a 255mm box before any prose is
      // trimmed — five hundredths of a millimetre — and the scorecard block
      // alone is 191mm of it, so this note is the only lever the fitter has
      // and it takes it. Making the note REQUIRED was tried and refuses the
      // pack: with the note held, the loop pops every footnote on the page
      // and is still 0.04mm over, so `assertFits` throws and the demo company
      // gets no pack at all. The five hundredths are not on the paper — the
      // browser lays the untrimmed page out around 252mm — but they are not a
      // wrong constant either: `SCORECARD_ROW_MM` is 7.45 against a CSS
      // arithmetic of 7.16 because a 27.07px row rounds up to 28 device
      // pixels, which is 7.41mm, and that allowance is real. See the fix
      // report for task 26; this needs a lever finer than a whole note.
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
    //
    // The basis page goes through `fitBasisPage` instead: its standfirst
    // COUNTS its caveats, and a count composed before the page is held to its
    // sheet is a count the fit can falsify. See `fitBasisPage`.
    ...body.map((p2) => (p2.navLabel === 'Basis of preparation'
      ? fitBasisPage(p2, basis, scale)
      : fitPageToBox(p2))),
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
