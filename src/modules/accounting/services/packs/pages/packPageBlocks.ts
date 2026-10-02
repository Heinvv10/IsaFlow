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
  impossibleBalancesSentence,
  negativeEquitySentence,
} from '@/modules/accounting/services/packs/narrative/derivedSentences';
import type { PackCashBridge } from './packPageCharts';
import type { SelectedMatters } from './packMattersPrinted';
import { matterSourcesInWords } from './packDerivedMatters';
import { commentary, disclose, mustDisclose, note } from './packBlockBuilders';
import type { MoneyScale } from '@/lib/format/money';
import { disproportionatePlugSentence } from '@/modules/accounting/services/packs/figures/packWaterfallIntegrity';
import { TOTAL_EQUITY_AND_LIABILITIES_KEY } from './packStatementTables';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type {
  PackChartSpec,
  PackNarrative,
  PackPageBlock,
  PackTable,
} from './packPageModel';

/** The four block constructors live in `packBlockBuilders.ts` — a leaf, so a
 *  page module this file imports can build a block without importing this
 *  file back. Re-exported because every existing caller imports them here. */
export { commentary, disclose, mustDisclose, note };

/** Pages 3 and 10 and page 6's bridge footnote split to their own modules
 *  for the 300-line cap — `packHighlightsBlocks.ts`, `packTrendBlocks.ts`
 *  and `packBridgeSignFootnote.ts`. Re-exported for the same reason. */
export { buildHighlightsBlocks } from './packHighlightsBlocks';
export { buildTrendBlocks } from './packTrendBlocks';
export { bridgeSignFootnote } from './packBridgeSignFootnote';

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
  // ONE BUILD, TWO FIELDS. Called twice on the same input the two cannot
  // disagree, but the shape invites the drift the `SelectedMatters` rule
  // exists to stop.
  const actions = boardActionItems(selection);
  return [
    // THE COUNTS ARE NOT DECISIONS. `boardActionsTail` is set smaller and
    // outside the list — see `BoardActions`.
    {
      kind: 'narrative',
      narrative,
      boardActions: actions.items,
      boardActionsTail: actions.tail,
    },
    disclose('How this page is prepared', [
      // NEITHER SENTENCE NAMES A COLUMN, because the page has two shapes.
      // With commentary approved the two sit side by side; with it pending
      // the placeholder is a line above the panel and there is no left or
      // right — see `packPrint.css`. These read "The left column…" and "The
      // right column…", which on every pack shipped so far was a sentence
      // describing a layout the sheet did not have.
      note('Commentary', 'This page carries the board\'s own commentary on the period. It prints only once an approver has signed it; until then the page says so rather than printing unapproved text.'),
      // THE LIST IS RENDERED, NOT TYPED. It named four checks and the panel
      // three lines below it carried a matter none of the four produces —
      // the net-credit month, which is the LARGEST exposure in both packs
      // and the one this page's own headline names. See `MATTER_SOURCES`.
      note('Action panel', `The panel headed 'For the board' is derived from the same checks the matters page tabulates — ${matterSourcesInWords()} — in the order the matters page prints them: matters with no single rand amount first, then the largest by exposure. It is machine-written and states the decision each matter is waiting on, never a recommendation.`),
    ]),
  ];
}

/** One line of page 7's "Balances below zero" block: the label the sheet
 *  prints and the amount it prints against it. */
export interface ImpossibleBalanceLine {
  label: string;
  amount: number;
}

/**
 * WHICH BALANCES PAGE 7 SAYS CANNOT BE HELD AS STATED — the one reading, so
 * a sheet that points at this statement points at something it made.
 *
 * `buildPositionBlocks` used to compute this inline and page 9's
 * disowned-base footnote re-derived the rule over a different field set, off
 * `PackFigureSet` directly. The two reached different answers: a negative
 * `cash` or `inventory` flagged a scorecard row with "which the balance
 * sheet says cannot be held as stated" while page 7 said nothing whatever
 * about either — neither is a row of the position table and inventory is not
 * printed anywhere in the twelve sheets. A pointer to a page that does not
 * carry it is the defect `da8ac596` and `a3794df2` closed from the other end.
 *
 * It is also the substantive answer. A negative cash balance is a bank
 * overdraft — a position a business genuinely holds, like the negative equity
 * this block deliberately excludes — which is exactly why the list is
 * restricted to the asset and liability ROWS this sheet states.
 */
export function impossibleBalanceLines(
  position: PackTable,
  set: PackFigureSet,
): ImpossibleBalanceLine[] {
  // The closing total is left out BY KEY: its label ends in "liabilities" and
  // it is the sum of two sides, not a balance held on either. It is negative
  // exactly when total assets are, and that row is already named.
  const tabulated = position.rows
    .filter((row) => row.key !== TOTAL_EQUITY_AND_LIABILITIES_KEY)
    .filter((row) => /assets$|liabilities$/i.test(row.label))
    .map((row) => ({ label: row.label, amount: row.figures.actual?.value ?? 0 }));
  const memorandum = [
    { label: 'Trade receivables', amount: set.current.accountsReceivable },
    { label: 'Trade payables', amount: set.current.accountsPayable },
  ];
  return [...tabulated, ...memorandum].filter((line) => line.amount < 0);
}

/** Page 7 — the balance sheet, its composition chart, and the MANDATORY
 *  §3.5 negative-equity disclosure when equity is underwater. */
export function buildPositionBlocks(
  position: PackTable,
  compositionChart: PackChartSpec,
  set: PackFigureSet,
  scale: MoneyScale,
  /** The lines this block names, from `impossibleBalanceLines`. Passed in
   *  rather than computed here because page 9's disowned-base footnote points
   *  at this block and must point at the SAME list — one call, two readers. */
  impossible: readonly ImpossibleBalanceLine[],
): PackPageBlock[] {
  const positionBlocks: PackPageBlock[] = [
    { kind: 'table', table: position },
    { kind: 'chart', chart: compositionChart },
    commentary(positionCaption(set, scale)),
  ];
  // THE SIGN CHECK, OVER EVERY ASSET AND LIABILITY LINE THIS PAGE PRINTS.
  //
  // It ran on TOTAL assets and on COMPONENT liabilities and on nothing else,
  // which is what let Brightsphere print `Non-current liabilities (424)` with
  // a headed block beside it and `Current assets (3 372)` three rows above
  // with none: that pack's total assets are positive, and the asset check
  // only ever looked at the total. Symmetric now — both sides, both levels —
  // read off the table the page prints, so it can only name a row the sheet
  // shows and states that row's own label.
  //
  // Equity is not in it. Negative equity is a real position a real business
  // can hold; it has its own §3.5 disclosure below, and folding it in here
  // would tell a director that insolvency is a posting error.
  //
  // AND THE MEMORANDUM COUNTS. `tradeBalancesFootnote` prints trade
  // receivables and trade payables at the foot of this sheet — they are on
  // the page, they are an asset and a liability, and Brightsphere's trade
  // receivables of (330) went unremarked under a headed block about balances
  // below zero. Reading the check off the TABLE alone is what missed it: the
  // rule is about what the sheet states, and this sheet states two figures it
  // does not tabulate.
  if (impossible.length > 0) {
    const hasAssets = impossible.some((l) => /assets$|receivables$/i.test(l.label));
    const hasLiabilities = impossible.some((l) => /liabilities$|payables$/i.test(l.label));
    positionBlocks.push(mustDisclose('Balances below zero', [
      note('What this means', impossibleBalancesSentence(
        impossible,
        hasAssets && hasLiabilities ? 'both' : (hasAssets ? 'assets' : 'liabilities'),
        scale,
      )),
    ]));
  }
  const equity = set.current.totalEquity;
  if (equity < 0) {
    positionBlocks.push(mustDisclose('Negative equity', [
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
  cashBridge: PackCashBridge,
  cashTrend: PackChartSpec | null,
  set: PackFigureSet,
  scale: MoneyScale,
): PackPageBlock[] {
  const cashBlocks: PackPageBlock[] = [{ kind: 'table', table: cash }];
  if (cashBridge.drawn) {
    cashBlocks.push({ kind: 'chart', chart: cashBridge.chart });
    // The bridge foots on a named plug, which is honest — but on these
    // figures the plug is larger than the net movement it sits inside, and a
    // bar that dwarfs its own subject needs saying out loud rather than
    // merely labelling. The gate requires this sentence whenever the share
    // breaches; the sentence itself is defined once, beside the check.
    const disproportionate = disproportionatePlugSentence(cashBridge.chart, scale);
    if (disproportionate !== null) {
      cashBlocks.push(mustDisclose('How much of this bridge is unexplained', [
        note('Size of the unexplained step', disproportionate),
      ]));
    }
  }
  else {
    // `why` is written for the reader on `buildCashWaterfallChart`, beside
    // the decision it explains — a second wording here is how the page and
    // the chart come to disagree about what the pack does not have.
    cashBlocks.push(mustDisclose('Movement in cash, and why no bridge is drawn', [
      note('This period', cashBridge.why),
    ]));
  }
  if (cashTrend) cashBlocks.push({ kind: 'chart', chart: cashTrend });
  else {
    cashBlocks.push(mustDisclose('No closing-cash series', [
      note('Why', 'No monthly trend series covers this period, so no closing-cash line can be drawn.'),
    ]));
  }
  cashBlocks.push(disclose('Commentary', [
    note('This period', cashCaption(set, cashBridge.drawn ? cashBridge.residual : null, scale)),
  ]));
  return cashBlocks;
}
