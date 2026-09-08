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
  highlightsTitle,
  narrativeTitle,
  boardActionMatters,
  positionTitle,
  scorecardScore,
  trendsTitle,
} from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { buildBasis, PACK_SCALE, statementFootnotes } from './packBasis';
import { dayCountsMeasured, tradeBalancesFootnote } from './packTradeBalances';
import { buildHighlightTiles } from './packHighlights';
import { buildScorecardGroups } from './packScorecard';
import {
  buildCashTrendChart,
  buildCashWaterfallChart,
  buildPositionCompositionChart,
  buildTrendPanels,
  TRENDS_PANELS_SPECIFIED,
} from './packPageCharts';
import {
  anchorColumn,
  anchorRow,
  buildCashTable,
  buildIncomeStatementTable,
  buildPositionTable,
} from './packStatementTables';
import {
  buildMonthlyResultsTable,
} from './packMonthlyResults';
import {
  buildCommentaryBlocks,
  buildHighlightsBlocks,
  buildPositionBlocks,
  impossibleBalanceLines,
  buildTrendBlocks,
} from './packPageBlocks';
import type { PackMatter } from './packMatters';
import { withDerivedMatters } from './packDerivedMatters';
import { partialMonthClauseFor, partialMonthOf } from './packPartialMonth';
import { selectPrintedMatters } from './packMattersPrinted';
import { fitPageToBox } from './packPageFit';
import { relaidNarrative } from './packNarrativeLayout';
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
import { buildIncomeStatementSheet } from './packIncomeSheet';
import { buildCashSheet } from './packCashSheet';
import { buildMonthlyResultsPage } from './packMonthlyPage';
import { buildScorecardPage, scorecardPageNotes } from './packScorecardNotes';
import { ledgerStalenessNote } from './packLedgerStaleness';
import { shortenedPanelsNote } from './packShortenedPanels';
import {
  receivablesBaseNote,
  receivablesReconciliationNote,
  type PackReceivablesRead,
} from './packReceivablesReconciliation';
import type { PackDraftReason } from './packDraftStatus';
import type {
  PackComparativePeriod,
  PackTable,
  PackNarrative,
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
  // THE PANELS BEFORE THE BASIS, because page 12's glossary states what the
  // TRENDS page does with a measure and Brightsphere's trends page draws no
  // debtor-days panel: its sheet 12 defined a variant that pack does not
  // print. The definition is a claim about the document, so the document has
  // to be asked.
  //
  // `PACK_SCALE` rather than `basis.numberConvention.scale`, which is not
  // computed yet and IS this constant — `buildBasis` sets it from here. One
  // call, not two: a second `buildTrendPanels` is a second answer to "which
  // panels does this pack draw", and the whole point is that page 12 and page
  // 10 give the same one.
  const trendPanels = buildTrendPanels(trend, PACK_SCALE);
  const basis = buildBasis(
    set, { generatedAt }, input.draftReasons, input.ledgerVersion, trend, p,
    new Set(trendPanels.panels.map((panel) => panel.id)),
  );
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
  // EVERY NUMBERED FOOTNOTE GETS THE SUPERSCRIPT IT PROMISES.
  //
  // The pack ran two footnote systems and only the lettered one worked: on
  // the live demo pack TWELVE numbered notes printed at the feet of pages 5
  // to 9 and not one had a marker anywhere on its sheet. Page 3's has always
  // been anchored, through `PackKpiTile.trendFootnote`, which is what made
  // the rest look deliberate.
  //
  // The numbers are fixed by `statementFootnotes`: 1 is the rounding note on
  // every statement page and 2 is the prior column's period, present only
  // where there IS a comparative. They are stamped here rather than in the
  // table builders because the NUMBER is a property of the page, and
  // `anchorRow` throws if the row it names is not there — an anchor that
  // silently matches nothing is the defect this replaces.
  const ROUNDING_FOOTNOTE = 1;
  const PRIOR_COLUMN_FOOTNOTE = 2;
  /** The rounding note belongs on the row a reader's addition lands on. */
  const anchorRounding = (table: PackTable): PackTable => {
    const last = [...table.rows].reverse()
      .find((row) => row.role === 'total' || row.role === 'grandTotal');
    return last === undefined ? table : anchorRow(table, (row) => row === last, ROUNDING_FOOTNOTE);
  };
  /** And the comparative's period belongs on the column heading that claims
   *  it — the one thing in the pack a footnote is about that is not a row. */
  const anchorPrior = (table: PackTable): PackTable => (
    comparativePeriod === null ? table : anchorColumn(table, 'prior', PRIOR_COLUMN_FOOTNOTE)
  );

  const tiles = buildHighlightTiles(set, trend, p);
  const monthlyResults = anchorRounding(buildMonthlyResultsTable(trend, p));
  const income = anchorPrior(anchorRounding(buildIncomeStatementTable(set, p)));
  const position = anchorPrior(anchorRounding(buildPositionTable(set, p)));
  const cash = anchorPrior(anchorRounding(buildCashTable(set, p)));
  const scorecard = buildScorecardGroups(set, p);
  const score = scorecardScore(scorecard);
  const cashBridge = buildCashWaterfallChart(set, scale);
  const cashTrend = buildCashTrendChart(trend, scale);
  // The panels themselves, for every reader that only needs the drawn list —
  // the page's cross-reference footnotes and the title's count. The scale
  // SPLIT (which of them share a y-domain) is read by `buildTrendBlocks`
  // alone, off the one decision `buildTrendPanels` made.
  const panels = trendPanels.panels;
  // PAGE 9'S ONE FOOTNOTE MARKS THE ROW IT IS ABOUT. `PackScorecardRow.footnote`
  // is rendered by `ScorecardTable` and has been since the row model was
  // written; the page simply never set it, so "Debtor days on this page … is
  // the figure for the WHOLE reporting period" printed under a Debtor days
  // row with nothing on it. Set only where the footnote is actually printed —
  // the panel it reciprocates is not drawn on every pack.
  // AND THE ROW THAT CARRIES A RED MISS CARRIES THE BASE CAVEAT WITH IT.
  //
  // Page 9 prints `Debtor days · 213 days · target 30 days · MISSED` in red,
  // and page 4 says the ratio is taken on trade receivables of 59 — the
  // control account — against an open customer subledger of 10 724, and to
  // "read the day count as a measure of the control account, not of what
  // customers owe". The pack scored a red miss against a base it disowns one
  // page earlier, and this row's only footnote was about annualisation. The
  // cross-reference ran one way.
  //
  // Fired on the SAME condition page 4's block is, by asking that builder, so
  // the two cannot come apart; and carried inside the existing footnote,
  // because sheet 9 has 2.77mm and a second one costs 3.88.
  // BUILT ONCE FOR THE WHOLE PACK. Page 4's block, page 9's flag and page
  // 11's own support block all turn on these two, and they were composed up
  // to four times between them purely to be tested for null.
  const receivablesReconciliation = receivablesReconciliationNote(
    input.receivables, set.current.accountsReceivable, scale,
  );
  const debtorsBase = receivablesBaseNote(
    input.receivables,
    set.current.accountsReceivable,
    scale,
    ['both', 'debtorOnly'].includes(dayCountsMeasured(set)),
    receivablesReconciliation,
  );
  const debtorsBaseApplies = debtorsBase !== null;
  // PAGE 9'S FOOTNOTES AND THE MARKERS THAT POINT AT THEM — see
  // `packScorecardNotes`. Three separate rulings' worth of reasoning, all
  // about one sheet's two footnotes, lifted out of the composer whole.
  const page7Impossible = impossibleBalanceLines(position, set);
  const scorecardNotes = scorecardPageNotes({
    scorecard, set, panels, comparativePeriod, debtorsBaseApplies, page7Impossible,
  });
  const scorecardPage = buildScorecardPage(score, scorecard, scorecardNotes);

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
    receivablesReconciliation,
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
  const matters = selectPrintedMatters(
    allMatters, mattersBudgetMm(mattersSupport, mattersHeadline, allMatters),
  );

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

  // PAGE 5 — THE RESULT MONTH BY MONTH, and the twelve notes that say how to
  // read the table. See `packMonthlyPage`; it moved out of this composer
  // whole, and nothing else here reads its locals.
  const snapshot = buildMonthlyResultsPage(monthlyResults, trend, set, scale, ROUNDING_FOOTNOTE);

  // PAGE 6 AND ITS BRIDGE, INCLUDING THE RUNG THE MEASURED SHEET CHOSE — see
  // `packIncomeSheet`. It is the largest self-contained piece this composer
  // held and it moved out whole; nothing else on the pack reads its locals.
  const incomeSheet = buildIncomeStatementSheet(income, set, scale, panels, statementNotes);

  // PAGE 8 AND THE RUNG ITS MEASURED SHEET CHOSE FOR THE CASH LINE — see
  // `packCashSheet`, the same construction page 6 uses for its bridge.
  const cashPage = buildCashSheet(cash, cashBridge, cashTrend, trend, set, scale, statementNotes);

  // PAGE 7'S MEMORANDUM MARKS THE TWO ROWS ITS BALANCES SIT INSIDE. Trade
  // receivables and trade payables are not rows of this table — they are the
  // splits a reader has to be given because the day counts on pages 3 and 9
  // are taken on them — so the marker goes on Current assets and Current
  // liabilities, which is where those balances are. It is the one numbered
  // footnote whose subject is a figure the sheet does not print, and marking
  // the rows that contain it is the closest thing to an anchor that is true.
  const positionTable = anchorRow(
    anchorRow(position, (row) => row.label.toLowerCase() === 'current assets',
      statementNotes.length + 1),
    (row) => row.label.toLowerCase() === 'current liabilities', statementNotes.length + 1,
  );
  const positionBlocks = buildPositionBlocks(
    positionTable, buildPositionCompositionChart(set, scale), set, scale, page7Impossible,
  );
  // WHICH DESTINATION CELLS ACTUALLY CARRY A COMPARATIVE, read off the tables
  // and the scorecard this pack composed rather than off the figure set they
  // came from. Page 10's note claims "all against the comparative but gross
  // margin", and the demo pack's page 9 prints Debtor days PRIOR as `n/m` —
  // the same state as gross margin's, and one the sentence did not name.
  //
  // A `PackFigure` whose `value` is null is a cell printing a reason instead
  // of a number, which is exactly what "prints no comparative" means to a
  // reader who turns to it.
  const rowPrior = (table: PackTable, label: string): boolean => (
    table.rows.find((r) => r.label.toLowerCase() === label)?.figures.prior?.value !== null
      && table.rows.some((r) => r.label.toLowerCase() === label)
  );
  const printsComparative = (panelId: string): boolean => {
    switch (panelId) {
      case 'trend-revenue': return rowPrior(income, 'revenue');
      case 'trend-operating-expenses': return rowPrior(income, 'operating expenses');
      case 'trend-net-profit': return rowPrior(income, 'net profit');
      case 'trend-cash': return rowPrior(cash, 'closing cash');
      case 'trend-debtor-days':
        return scorecard.some((g) => g.rows.some(
          (r) => r.metric.toLowerCase() === 'debtor days' && r.prior?.value !== null && r.prior !== undefined,
        ));
      // Gross margin's exception is structural — page 6 carries no comparative
      // column for the ratio at all — and `printsAgainstComparative` already
      // states it, so this reading cannot make it worse or better.
      default: return true;
    }
  };
  const trendBlocks = buildTrendBlocks(trendPanels, printsComparative);

  const staleLedger = ledgerStalenessNote(input.ledgerVersion, trend, set.currentWindow.end);
  // WHICH RECEIVABLES BALANCE THE DAY COUNT IS TAKEN ON, read through the
  // SAME function page 7's memorandum decides its own pointer by, so a page
  // cannot qualify a measure the scorecard does not state.
  // AND THE RULE FOR A PANEL THAT STARTS LATE. Brightsphere states why a
  // panel is ABSENT; the demo draws a shortened one and stated nothing. See
  // `shortenedPanelsNote` for why it is on this sheet and not page 10.
  const shortPanels = shortenedPanelsNote(trendPanels.shortenedPanels, trend);

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
    scorecardPage,
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
  // AND HOW MANY BRIDGES THE COLOUR KEY IS ABOUT — counted off the composed
  // body rather than assumed, because page 8's cash bridge is refused where
  // there is nothing to bridge through and the demo pack draws one waterfall,
  // under a key reading "On the bridges".
  const bridgesDrawn = body
    .flatMap((p2) => p2.blocks)
    .filter((b) => b.kind === 'chart' && b.chart.kind === 'waterfall').length;
  const basisPage = buildBasisPage(
    basis, input.companyLegalName, input.period, comparativePeriod, scale, currency,
    printedCaveats(fittedContents, basis), bridgesDrawn,
  );
  const pages = numbered([
    cover!,
    fittedContents,
    // EVERY page, held to its sheet — the same rule the matters table spends
    // its budget under, applied to the prose on the other eleven. A page that
    // already fits comes back untouched.
    //
    // LAYOUT FIRST, THEN THE FIT. `relaidNarrative` decides which of page 4's
    // two shapes the narrative block is drawn in — see the module, and note
    // that it drops nothing. It runs BEFORE `fitPageToBox` because that
    // function may take disclosure notes and page footnotes and nothing else,
    // and that list is the guarantee no figure is ever trimmed off a sheet.
    ...body.map((p2) => fitPageToBox(relaidNarrative(p2))),
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
