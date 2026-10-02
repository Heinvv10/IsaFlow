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

import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import {
  highlightsTitle,
  scorecardScore,
  trendsTitle,
} from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { buildBasis, PACK_SCALE, statementFootnotes } from './packBasis';
import { buildHighlightTiles } from './packHighlights';
import { buildScorecardGroups } from './packScorecard';
import {
  buildCashTrendChart,
  buildCashWaterfallChart,
  buildTrendPanels,
  TRENDS_PANELS_SPECIFIED,
} from './packPageCharts';
import {
  buildCashTable,
  buildIncomeStatementTable,
  buildPositionTable,
} from './packStatementTables';
import {
  buildMonthlyResultsTable,
} from './packMonthlyResults';
import {
  buildHighlightsBlocks,
  buildTrendBlocks,
} from './packPageBlocks';
import { partialMonthOf } from './packPartialMonth';
import {
  buildMattersBlock,
  MATTERS_NAV_LABEL,
} from './packMattersPage';
// Debtor days printed 213 on the scorecard page and 63.7 on the trends
// page, one sheet apart, with nothing on either saying that one is the
// period and the other a month.
import { formatPackPeriod } from './packPeriodLabel';
import {
  page,
  type UnnumberedPage,
} from './packFrontMatter';
import { buildIncomeStatementSheet } from './packIncomeSheet';
import { buildCashSheet } from './packCashSheet';
import { buildMonthlyResultsPage } from './packMonthlyPage';
import { ledgerStalenessNote } from './packLedgerStaleness';
import { shortenedPanelsNote } from './packShortenedPanels';
import type { BoardPackInput } from './packBoardPackInput';
import { statementFootnoteAnchors } from './packStatementFootnoteAnchors';
import { buildScorecardSheet } from './packScorecardSheet';
import { selectBoardPackMatters } from './packMattersSelection';
import { buildPositionSheet } from './packPositionSheet';
import { comparativeReader } from './packPrintsComparative';
import { buildNarrativePage } from './packNarrativePage';
import { assembleBoardPackDocument } from './packDocumentAssembly';
import type {
  PackComparativePeriod,
  PackPagesDocument,
} from './packPageModel';

/** The composer's input and the printed-strings walk live in
 *  `packBoardPackInput.ts` and `packPrintedStrings.ts`, split out for the
 *  300-line cap. Re-exported because every existing caller imports it here. */
export type { BoardPackInput };

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
  // EVERY NUMBERED FOOTNOTE GETS THE SUPERSCRIPT IT PROMISES — see
  // `packStatementFootnoteAnchors`, which holds the two numbers and the two
  // functions that stamp them on.
  const { ROUNDING_FOOTNOTE, anchorRounding, anchorPrior } = statementFootnoteAnchors(comparativePeriod);

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
  // PAGE 9, AND THE THREE READINGS IT SHARES WITH PAGES 4, 7 AND 11 — see
  // `packScorecardSheet`. Built once for the whole pack.
  const { receivablesReconciliation, debtorsBase, page7Impossible, scorecardPage } =
    buildScorecardSheet(input, set, scale, position, scorecard, score, panels, comparativePeriod);

  // PAGE 11'S OWN BLOCKS, BEFORE ITS TABLE, AND THE ONE SELECTION pages 4 and
  // 11 both read — see `packMattersSelection`.
  const { mattersSupport, mattersHeadline, matters } =
    selectBoardPackMatters(input, receivablesReconciliation, trend, scale, set);

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

  // PAGE 7, WITH ITS MEMORANDUM ANCHORED AND ITS CHART AT THE HEIGHT THE
  // MEASURED SHEET CHOSE — see `packPositionSheet`.
  const positionPage = buildPositionSheet(position, statementNotes, set, scale, page7Impossible);
  // WHICH DESTINATION CELLS ACTUALLY CARRY A COMPARATIVE — see
  // `packPrintsComparative`.
  const printsComparative = comparativeReader(income, cash, scorecard);
  const trendBlocks = buildTrendBlocks(trendPanels, printsComparative);

  const staleLedger = ledgerStalenessNote(input.ledgerVersion, trend, set.currentWindow.end);
  // WHICH RECEIVABLES BALANCE THE DAY COUNT IS TAKEN ON, read through the
  // SAME function page 7's memorandum decides its own pointer by, so a page
  // cannot qualify a measure the scorecard does not state.
  // AND THE RULE FOR A PANEL THAT STARTS LATE. Brightsphere states why a
  // panel is ABSENT; the demo draws a shortened one and stated nothing. See
  // `shortenedPanelsNote` for why it is on this sheet and not page 10.
  const shortPanels = shortenedPanelsNote(trendPanels.shortenedPanels, trend);

  // Page 4 — no tabular figures. See `packNarrativePage`.
  const narrativePage = buildNarrativePage(matters, scale, input, staleLedger, debtorsBase, shortPanels);

  const body: UnnumberedPage[] = [
    highlights,
    narrativePage,
    snapshot,
    incomeSheet,
    // PAGE 7 CARRIES THE TWO BALANCES THE DAY COUNTS ARE TAKEN ON. Debtor
    // days and creditor days print on pages 3 and 9 and their numerators
    // printed nowhere in either pack — see `positionSheet` above.
    positionPage,
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

  // THE FRONT PAGES, THE BASIS PAGE, THE NUMBERING AND THE INTEGRITY GATE —
  // see `packDocumentAssembly`. The gate is still the last thing that
  // happens: a pack whose figures do not reconcile never becomes a document.
  return assembleBoardPackDocument(
    body, input, generatedAt, trend, scale, currency, basis, comparativePeriod, draft, p,
  );
}
