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
  boardActionMatters,
  negativeRevenueSentence,
  positionTitle,
  scorecardCaption,
  scorecardScore,
  scorecardTitle,
  trendsTitle,
} from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { buildBasis, ROUNDING_FOOTNOTES, statementFootnotes } from './packBasis';
import { dayCountsMeasured, tradeBalancesFootnote } from './packTradeBalances';
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
  GROUP_RESULTS_NAV_LABEL,
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
import { partialMonthClauseFor, partialMonthOf } from './packPartialMonth';
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
  buildFrontPages,
  BASIS_NAV_LABEL,
  fitContentsPage,
  numbered,
  page,
  printedCaveats,
  type UnnumberedPage,
} from './packFrontMatter';
import { ledgerStalenessNote } from './packLedgerStaleness';
import { shortenedPanelsNote } from './packShortenedPanels';
import {
  receivablesBaseNote,
  receivablesReconciliationNote,
  type PackReceivablesRead,
} from './packReceivablesReconciliation';
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
  /**
   * What the pack knows about its own receivables: the aged debtors total
   * where a sheet prints it, the full open subledger, and
   * `reconcileSubledger`'s decomposition of the difference between the
   * subledger and the control account. Page 11 reconciles the two printed
   * debtors figures from it and page 4 discloses which of them debtor days
   * is measured on. See `packReceivablesReconciliation.ts`.
   */
  receivables: PackReceivablesRead;
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
  const statementNotes = statementFootnotes(comparativePeriod, set.currentWindow);

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
  // PAGE 11 CARRIES THE RECONCILIATION OF THE TWO DEBTORS FIGURES THE PACK
  // PRINTS, and it is a SUPPORT block rather than something appended after
  // the table, because this page's table is budgeted against whatever its
  // support blocks leave behind — see `packReceivablesReconciliation.ts` for
  // what that costs and why it is the right way round.
  const mattersSupport = buildMattersSupportBlocks(
    input.mattersCommentary ?? pending,
    receivablesReconciliationNote(input.receivables, set.current.accountsReceivable, scale),
  );
  // The title first, from the FULL list: the budget the table spends depends
  // on how much paper the header leaves, and the headline must not change
  // when a row moves off the page.
  // The checks that reach this page all read the ledger; one anomaly is
  // visible only in the SERIES — see `creditMonthMatters`.
  // THE PERIOD'S NET PROFIT IS AN ARGUMENT, not a fact the derived sentence
  // infers from the branch it is written in — see `CREDIT_MONTH_STANDING`.
  const allMatters = withDerivedMatters(input.matters, trend, scale, set.current.netProfit);
  const mattersHeadline = mattersTitle(allMatters, scale);
  const matters = selectPrintedMatters(allMatters, mattersBudgetMm(mattersSupport, mattersHeadline));

  // Page 3 — the whole period in one page. Spec §4.A: eight tiles, each with
  // its delta and the basis that delta is measured against.
  const { blocks: highlightBlocks, footnotes: highlightFootnotes } =
    buildHighlightsBlocks(tiles, scale, currency, comparativePeriod, partialMonthOf(trend));
  // ONE FOOTNOTE ON THIS SHEET, AND IT IS ANCHORED.
  //
  // The page carried a second, `highlightsComparativeFootnote` — "Revenue has
  // no positive comparative base for a percentage change." — with no
  // superscript anywhere on the sheet to attach it to, beside a footnote 1
  // correctly anchored to five tiles. That made the orphan conspicuous rather
  // than invisible, and the sentence was already on the page anyway: the
  // revenue tile's own caption prints `NOT_A_POSITIVE_BASE` in exactly the
  // condition that footnote fired in (`PackKpiDeltaAbsence.unusableBase`),
  // anchored to the tile by position. Two statements of one fact, one of them
  // pointing at nothing.
  const highlights = page(highlightsTitle(set, scale), 'Highlights', 'Performance', 'high', highlightBlocks, 'portrait',
    highlightFootnotes);

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
        // SHORTENED BY ONE LINE, AND WHAT WENT WAS A SECOND NAMING OF THE
        // SAME THREE BANDS. It read "Cost of sales, Operating and Other are
        // the three bands every expense of a month falls into: cost of sales,
        // everything else above the operating line, and everything below it"
        // — the three column names, then the same three glossed in order, so
        // "cost of sales" appeared twice in one sentence. Naming each band
        // once with its gloss attached says the same thing in three lines
        // instead of four. Every fact stays: what Revenue and Other income
        // are, what each of the three expense bands contains, and that the
        // row adds across.
        note('The columns', 'Revenue is turnover; Other income is what the income statement '
          + 'reports separately. Expenses fall in three: Cost of sales; Operating, above the '
          + 'operating line; Other, below it. The two income columns less the three expense '
          + 'columns are the month\'s net profit, so each row adds across.'),
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
        // AND SHORTENED, for the same reason and by the same rule. "The
        // reporting period is stated in the footer of every sheet" is a fact
        // the footer of THIS sheet states; the note's job is to say that this
        // table's window is not that period and where the period's own totals
        // are. Both survive, in three lines rather than four, which is what
        // kept the part-month clause on Brightsphere's sheet 5.
        // "WHICH IS THE SERIES PAGE 10 DRAWS" WAS FALSE ON THE DEMO PACK,
        // and true on Brightsphere — the asymmetry is the whole finding.
        // Two of the demo's six panels, gross margin and debtor days, run
        // Jul 2026 to Sep 2026 (part) and say "over 3 periods" in their own
        // titles, because revenue is nil before July and neither ratio is
        // defined without it. `ratioPanel` drops the months it cannot
        // measure rather than plotting a false zero, which is right — and
        // nothing in the demo pack stated that it does.
        //
        // Brightsphere carries the OMISSION rule under `Panels not drawn`:
        // "A panel is omitted when its figure is not meaningful in every
        // period of the window." Its four drawn panels are all 12 periods,
        // so its copy of this sentence is true. The demo has the other case
        // — a measure meaningful in SOME periods — and had no rule for it.
        // The two behaviours are consistent once both are stated: omit where
        // the measure exists nowhere in the window, shorten where it exists
        // in part of it. Shortening is kept rather than converted to
        // omission, because a gross margin over the three months revenue
        // exists is a real measurement and dropping it removes drawn content
        // to make a sentence true.
        //
        // THE RULE IS STATED HERE AND NOT ON PAGE 10, and that is the paper
        // talking. Page 10 composes at 252.47mm of 255 on `liveDemoRendered`
        // — 2.53mm against a block of six or more — and `fitPageToBox`
        // answers an overflow there by dropping the Scale and Period notes,
        // so the page would buy this rule by apologising for its own layout.
        // This note is the pack's one statement about how page 5's window
        // and page 10's panels relate, it is where the false claim was, and
        // the panel titles already carry the period count a reader meets.
        // "WHICH IS THE SERIES PAGE 10 DRAWS" WAS FALSE ON THE DEMO PACK,
        // and true on Brightsphere — the asymmetry is the whole finding.
        // Two of the demo's six panels, gross margin and debtor days, run
        // Jul 2026 to Sep 2026 (part) and say "over 3 periods" in their own
        // titles, because revenue is nil before July and neither ratio is
        // defined without it. Brightsphere's four drawn panels are all twelve
        // periods, so its copy of this sentence was true, which is how the
        // claim survived fourteen gates.
        //
        // "The window page 10 draws from" is true of both: every panel is
        // taken from this window, and a panel that can only be measured over
        // part of it plots that part. It is FOUR CHARACTERS SHORTER than the
        // claim it replaces, which is the whole reason it is this wording —
        // this note has ten to fourteen characters of slack on
        // `liveDemoRendered` (page 5 composes at 251.93mm of 255 and a line
        // of this narrative costs 4.94), and at fifteen more characters
        // `fitPageToBox` drops a note and the sheet apologises for its own
        // layout. The RULE that makes the shortening legible is a different
        // sentence and could not be bought here at any price; see
        // `shortenedPanelsNote`.
        note('The window', `This table covers ${trendWindowLabel(trend)}, the window page 10 `
          + 'draws from. The income statement overleaf carries the reporting period\'s own '
          + 'totals against the comparative.'
          + (partialMonthClauseFor(trend) === null ? '' : ` ${partialMonthClauseFor(trend)}`)),
      ]),
    ];
  const monthlyBlocks: PackPageBlock[] = [
    ...monthlySeriesBlocks,
    // THE PACK'S ONE NON-IFRS MEASURE STAYS ON THIS SHEET — see
    // `ebitdaMemoSentence` for why it is stated rather than tabulated, and
    // why sheet 6 could not take it with the note that has to identify it.
    mustDisclose('The reporting period\'s EBITDA', [
      note('EBITDA', ebitdaMemoSentence(set, scale, trend.length === 0 ? null : trendWindowLabel(trend))),
    ]),
    commentary(monthlyResultsCaption(trend, scale)),
  ];
  const snapshot = page(monthlyResultsTitle(trend, scale), GROUP_RESULTS_NAV_LABEL, 'Financials', 'high',
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
      commentary(largestMoverCaption(income.rows, scale)),
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

  const staleLedger = ledgerStalenessNote(input.ledgerVersion, trend, set.currentWindow.end);
  // WHICH RECEIVABLES BALANCE THE DAY COUNT IS TAKEN ON, read through the
  // SAME function page 7's memorandum decides its own pointer by, so a page
  // cannot qualify a measure the scorecard does not state.
  // AND THE RULE FOR A PANEL THAT STARTS LATE. Brightsphere states why a
  // panel is ABSENT; the demo draws a shortened one and stated nothing. See
  // `shortenedPanelsNote` for why it is on this sheet and not page 10.
  const shortPanels = shortenedPanelsNote(trendPanels.shortenedPanels, trend);
  const debtorsBase = receivablesBaseNote(
    input.receivables,
    set.current.accountsReceivable,
    scale,
    ['both', 'debtorOnly'].includes(dayCountsMeasured(set)),
  );

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
  //
  // THE TITLE IS ABOUT THIS PAGE'S PAYLOAD — see `narrativeTitle`, and note
  // that `boardActionMatters` is the same list the panel below prints, not a
  // second count of the selection.
  //
  // Its footnote went with the old title: `narrativeComparativeFootnote`
  // existed to explain why the headline's net-profit percentage could not be
  // formed, and the headline no longer states one. It was also the second
  // unanchored footnote in the pack.
  const narrativePage = page(
    narrativeTitle(boardActionMatters(matters), matters.printed.length + matters.omitted.length, scale),
    'Commentary and actions',
    'Performance',
    'medium',
    // AND THE ONE FACT ABOUT THE FIGURE SET THAT BELONGS ON THE FIRST PAGE
    // A BOARD READS: whether the ledger has moved since it was last posted
    // to. Null on a current ledger, which is most packs — see
    // `ledgerStalenessNote` for the three conditions and for why this sheet
    // rather than page 5 or page 12.
    [
      ...buildCommentaryBlocks(input.commentary ?? pending, matters),
      ...(staleLedger === null ? [] : [staleLedger]),
      ...(debtorsBase === null ? [] : [debtorsBase]),
      ...(shortPanels === null ? [] : [shortPanels]),
    ],
    'portrait',
    [],
  );

  const body: UnnumberedPage[] = [
    highlights,
    narrativePage,
    snapshot,
    incomeSheet,
    // PAGE 7 CARRIES THE TWO BALANCES THE DAY COUNTS ARE TAKEN ON. Debtor
    // days and creditor days print on pages 3 and 9 and their numerators
    // printed nowhere in either pack — see `packTradeBalances.ts` for why it
    // is a footnote rather than two memorandum rows, and what that cost.
    page(positionTitle(set, scale), 'Balance sheet', 'Financials', 'high', positionBlocks, 'portrait', [
      ...statementNotes,
      tradeBalancesFootnote(set, scale, statementNotes.length + 1),
    ]),
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
      // AND WHAT "SCORED" EXCLUDES, because the page's headline counts three
      // scored targets over a table printing four. The fourth is on a metric
      // whose figures do not support it (`statusFor`: a null value is
      // NOT MEANINGFUL, whether or not a target is set on it), so it is
      // neither met nor missed and the count leaves it out. That was
      // recoverable from the Status column and from page 12's "Scored,
      // unscored and not meaningful" entry, and stated nowhere on the sheet
      // whose largest type does the counting. It costs this page NOTHING:
      // the note was 122 characters over a 174mm measure and is 194, both
      // two lines of 9.5pt — measured, on the one page in the pack with less
      // than two millimetres of slack.
      disclose('Scoring basis', [
        note('Definitions', 'Each metric is scored against the platform\'s default target. A target on a metric the figures cannot support is not counted as scored; the basis page defines the terms and every formula used here.'),
      ]),
    ], 'portrait', periodWindowFootnotes(panels, 'trend-debtor-days', 'Scorecard', 1)),
    // PORTRAIT, like the other eleven. This was the one landscape sheet in
    // the pack — six panels three across needed the width — and printed and
    // bound it was the sheet a director had to turn. Two across at 83mm fits
    // the portrait measure, and the 255mm box gives each panel 48mm instead
    // of 36. Orientation stays a PAGE-level property (R5): the capability is
    // unchanged, no page asks for it.
    // THE PANEL COUNT IS NOT THE HEADLINE. "6 of 6 panels are drawn" is a
    // rendering status and it was the last clause of the sentence a director
    // reads first — see `trendsTitle`.
    //
    // AND IT NEEDED NOWHERE NEW TO GO. The page's own caption already opens
    // "6 metrics are tracked over the period", and where a measure is
    // MISSING the mandatory `Panels not drawn` block above names how many
    // could be drawn, which of the six they are and why. A footnote saying
    // "all six are drawn" on top of that is the rendering status again, in a
    // smaller size: measured, it cost this page 5.9mm, and on the live demo
    // company the fitter paid for it by dropping the window note — the
    // paragraph that stops a director reading 100.0% here against (1310.8%)
    // on sheet 6 as a contradiction. Not a trade this page makes.
    page(trendsTitle(trend, scale, TRENDS_PANELS_SPECIFIED), 'Trends', 'Performance', 'high', trendBlocks),
    page(mattersHeadline, MATTERS_NAV_LABEL, 'Governance', 'medium', [
      // Spec §4.A page 11 asks for a TABLE — issue, quantum, owner, movement,
      // decision required. Prose notes carried the same five facts but a
      // director scanning for "which of these needs me" had to read every
      // paragraph to find the owner column.
      buildMattersBlock(matters, p),
      ...mattersSupport,
    ]),
  ];

  // Page 2 says where the full basis is; it is the LAST page, counted rather
  // than written as the literal 12 it used to be. The basis page is not in
  // `body` yet — see below — so it is counted here.
  const total = 2 + body.length + 1;
  const [cover, contents] = buildFrontPages({
    companyLegalName: input.companyLegalName,
    period: input.period,
    preparedBy: input.preparedBy,
    generatedAt,
    draftReasons: input.draftReasons,
    partialMonth: partialMonthClauseFor(trend),
    scale,
    currency,
    basis,
    basisPageNumber: total,
  });
  // THE CONTENTS PAGE IS FITTED BEFORE THE BASIS PAGE IS COMPOSED, and the
  // order is the whole point. The caveats print with the contents now, and
  // the basis page's standfirst counts them and says where they are — a
  // count composed before the contents page is held to its sheet is a count
  // that fit can falsify. See `fitContentsPage`.
  // THE LABELS, not the count: the index wraps a long one onto a second line
  // and the reserve has to know. Page 12 is not composed yet — it is composed
  // FROM this fit — so it is named by its constant.
  const fittedContents = fitContentsPage(
    contents!, [cover!, contents!, ...body].map((p2) => p2.navLabel).concat(BASIS_NAV_LABEL));
  const basisPage = buildBasisPage(
    basis, input.period, comparativePeriod, scale, currency, printedCaveats(fittedContents, basis),
  );
  const pages = numbered([
    cover!,
    fittedContents,
    // EVERY page, held to its sheet — the same rule the matters table spends
    // its budget under, applied to the prose on the other eleven. A page that
    // already fits comes back untouched.
    ...body.map((p2) => fitPageToBox(p2)),
    fitPageToBox(basisPage),
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
