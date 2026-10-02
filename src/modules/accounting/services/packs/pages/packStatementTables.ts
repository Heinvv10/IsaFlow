/**
 * Three statement tables of the board pack: the income statement (page 6),
 * financial position (page 7) and cash (page 8). Page 5's is a different
 * shape — rows are months, not lines — and lives in `packMonthlyResults.ts`.
 *
 * Nothing here reads the ledger. Every actual is copied off `PackFigureSet`
 * or off `calculateExtendedRatios`, and the only arithmetic is the change
 * column — `actual − prior` and its percentage — which is a property of the
 * two figures beside it rather than a fifth number fetched from somewhere
 * else. That is the whole reason the comparative columns cannot drift from
 * the statement they sit in.
 *
 * TWO COLUMN RULES, both of them R3 ("an absent comparative is an absent
 * COLUMN, never zeros"):
 *   1. No prior period means the prior, change and change-% columns are not
 *      declared at all. A pack for a first-period company shows one column,
 *      not four with three of them empty — and never a zeroed prior, which
 *      would print −100% against every real figure.
 *   2. Non-positive revenue does NOT remove the "% of revenue" column — it
 *      makes every cell in it `n/m` against a stated reason. `marginPct`
 *      returns null on a non-positive base for a good reason: the sign of the
 *      result stops tracking the sign of the story, so a cost line would
 *      print a flattering positive percentage of a negative turnover. But
 *      DELETING the column is not this pack's way of saying so anywhere else
 *      — it prints the reason in place of the number — and Brightsphere's
 *      sheet 6 silently lost a column the demo pack shows, which reads as a
 *      pack with a different shape rather than a company with negative
 *      turnover. Rule 1 is genuinely different: there the whole comparative
 *      PERIOD is absent, so there is no column to have a reason about.
 */

import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import {
  absentComparativeCashFlow,
  absentOperatingCashFlow,
  investingCashFlowOf,
  OPERATING_PROFIT_SOURCE,
  operatingProfitOf,
} from '@/modules/accounting/services/packs/figures/packMetricReads';
import { buildTable } from './packStatementRows';
import type { PackTable } from './packPageModel';

/** The row and column machinery and the footnote anchors split to
 *  `packStatementRows.ts` and `packTableAnchors.ts` for the 300-line cap.
 *  Re-exported because every existing caller imports them here. */
export { REVENUE_NOT_A_POSITIVE_BASE } from './packStatementRows';
export { anchorRow, anchorColumn } from './packTableAnchors';

const grossProfitOf = (f: ReportPackFigures): number => f.revenue - f.costOfSales;


/** Page 6 — the condensed P&L, six data columns being the ceiling. */
export function buildIncomeStatementTable(set: PackFigureSet, p: PackFigureProvenance): PackTable {
  const { current, prior } = set;
  return buildTable(p, [
    { label: 'Revenue', key: 'is.revenue', source: 'packFigureSet.current.revenue', actual: current.revenue, prior: prior?.revenue ?? null },
    { label: 'Cost of sales', key: 'is.costOfSales', source: 'packFigureSet.current.costOfSales', level: 1, actual: current.costOfSales, prior: prior?.costOfSales ?? null },
    { label: 'Gross profit', key: 'is.grossProfit', source: 'packStatementTables.grossProfit', role: 'subtotal', actual: grossProfitOf(current), prior: prior ? grossProfitOf(prior) : null },
    { label: 'Operating expenses', key: 'is.operatingExpenses', source: 'packFigureSet.current.operatingExpenses', level: 1, actual: current.operatingExpenses, prior: prior?.operatingExpenses ?? null },
    { label: 'Other income', key: 'is.otherIncome', source: 'packFigureSet.current.otherIncome', level: 1, actual: current.otherIncome ?? 0, prior: prior?.otherIncome ?? null },
    { label: 'Operating profit', key: 'is.operating', source: OPERATING_PROFIT_SOURCE, role: 'subtotal', actual: operatingProfitOf(current), prior: prior ? operatingProfitOf(prior) : null },
    // BELOW THE OPERATING LINE, BECAUSE THAT IS WHERE THE COMPUTATION PUTS IT.
    //
    // `aggregateFigures` is explicit — `operatingProfit = grossProfit +
    // otherIncome − operatingExpenses` and `netProfit = operatingProfit −
    // otherExpenses` — so other expenses is a NON-OPERATING item in this
    // ledger's own income statement, and `operatingProfitOf`'s fallback says
    // the same. This table printed it INSIDE the operating block anyway: a
    // director summing the visible rows down to Operating profit on the
    // Brightsphere pack got (1 408) where the subtotal printed (1 819), the
    // difference being the 411 of other expenses standing above a subtotal
    // that excludes it. The figures were right and the layout contradicted
    // them.
    //
    // It is nil on the demo company, so the demo data hid this completely —
    // the same fixture-against-live lesson as the matters budget. The rest of
    // the platform already lays it out this way: see
    // `incomeStatementPackRows`, which puts Other Expenses after Operating
    // Profit.
    { label: 'Other expenses', key: 'is.otherExpenses', source: 'packFigureSet.current.otherExpenses', level: 1, actual: current.otherExpenses ?? 0, prior: prior?.otherExpenses ?? null },
    { label: 'Net profit', key: 'is.netProfit', source: 'packFigureSet.current.netProfit', role: 'total', actual: current.netProfit, prior: prior?.netProfit ?? null },
  ], set, true);
}

/**
 * What the closing row of page 7 is issued as. Exported so the identity that
 * holds it to the two totals above it names the source rather than a copy.
 */
export const TOTAL_EQUITY_AND_LIABILITIES_SOURCE = 'packStatementTables.totalEquityAndLiabilities';

/** That row's key. It is a total OF two sides, not a line on either, and its
 *  label ends in "liabilities" — so a reader that sorts rows into sides by
 *  label has to be able to leave it out by name. */
export const TOTAL_EQUITY_AND_LIABILITIES_KEY = 'sofp.totalEquityAndLiabilities';

/**
 * Page 7 — the position, current/non-current split on both sides.
 *
 * EQUITY BEFORE LIABILITIES, CLOSING ON THEIR COMBINED TOTAL — the order
 * `toBalanceSheetRows` and `toManagementBsRows` print on screen, in the AFS
 * and in the legacy pack. This table had liabilities first and closed on
 * Total equity, so the pack and the statement it summarises laid one balance
 * sheet out two ways, and the pack never printed the figure a reader checks
 * against Total assets.
 *
 * The closing total is DERIVED, on the same terms as the statement layer's:
 * the classifier has no field for it. `packStatementIdentities` holds it to
 * the two totals it is the sum of.
 */
export function buildPositionTable(set: PackFigureSet, p: PackFigureProvenance): PackTable {
  const { current, prior } = set;
  const nonCurrentAssets = (f: ReportPackFigures): number => f.totalAssets - f.currentAssets;
  const nonCurrentLiabilities = (f: ReportPackFigures): number => f.totalLiabilities - f.currentLiabilities;
  const equityAndLiabilities = (f: ReportPackFigures): number => f.totalEquity + f.totalLiabilities;
  return buildTable(p, [
    { label: 'Current assets', key: 'sofp.currentAssets', source: 'packFigureSet.current.currentAssets', level: 1, actual: current.currentAssets, prior: prior?.currentAssets ?? null },
    { label: 'Non-current assets', key: 'sofp.nonCurrentAssets', source: 'packStatementTables.nonCurrentAssets', level: 1, actual: nonCurrentAssets(current), prior: prior ? nonCurrentAssets(prior) : null },
    { label: 'Total assets', key: 'sofp.totalAssets', source: 'packFigureSet.current.totalAssets', role: 'subtotal', actual: current.totalAssets, prior: prior?.totalAssets ?? null },
    { label: 'Total equity', key: 'sofp.totalEquity', source: 'packFigureSet.current.totalEquity', role: 'subtotal', actual: current.totalEquity, prior: prior?.totalEquity ?? null },
    { label: 'Current liabilities', key: 'sofp.currentLiabilities', source: 'packFigureSet.current.currentLiabilities', level: 1, actual: current.currentLiabilities, prior: prior?.currentLiabilities ?? null },
    { label: 'Non-current liabilities', key: 'sofp.nonCurrentLiabilities', source: 'packStatementTables.nonCurrentLiabilities', level: 1, actual: nonCurrentLiabilities(current), prior: prior ? nonCurrentLiabilities(prior) : null },
    { label: 'Total liabilities', key: 'sofp.totalLiabilities', source: 'packFigureSet.current.totalLiabilities', role: 'subtotal', actual: current.totalLiabilities, prior: prior?.totalLiabilities ?? null },
    { label: 'Total equity and liabilities', key: TOTAL_EQUITY_AND_LIABILITIES_KEY, source: TOTAL_EQUITY_AND_LIABILITIES_SOURCE, role: 'total', actual: equityAndLiabilities(current), prior: prior ? equityAndLiabilities(prior) : null },
  ], set, false);
}

/**
 * Page 8 — the condensed cash flow.
 *
 * Opening cash is the PRIOR period's closing cash, so a first-period company
 * has none: the row states that rather than opening at zero, which would
 * assert the business started the period with an empty bank account.
 */
export function buildCashTable(set: PackFigureSet, p: PackFigureProvenance): PackTable {
  const { current, prior } = set;
  // Null, not `?? 0`, where the pack has no investing figure: that is an
  // ARTEFACT, not a period with no investing activity, and the two other cash
  // rows already say "not captured" when their figure is absent. R-P44/R-P45's
  // doctrine, applied consistently — see `investingCashFlowOf`.
  const investing = investingCashFlowOf;
  // "NOT CAPTURED" IS NOT "COULD NOT BE READ". Where the cash flow read
  // itself failed, the figure set says so (`cashFlowUnavailable`) and the
  // three flow rows print THAT — "no figure was captured" is true of a
  // failed read and reads as a company with no cash flows. The comparative
  // cells take the comparative's own reason the same way.
  const notRead = current.cashFlowUnavailable;
  // The comparative's reason names its own period — see
  // `absentComparativeCashFlow`, which page 9 prints for the same source.
  const priorNotRead = prior === null || !prior.cashFlowUnavailable
    ? undefined
    : absentComparativeCashFlow(prior, current);
  return buildTable(p, [
    {
      label: 'Opening cash',
      key: 'cash.opening',
      source: 'packFigureSet.prior.cash',
      role: 'subtotal',
      actual: prior?.cash ?? null,
      prior: null,
      unavailable: 'There is no prior period, so no opening cash balance carries forward into this one.',
      // AND THE COMPARATIVE OF AN OPENING BALANCE IS A PERIOD THIS PACK DOES
      // NOT READ. This row's actual is the comparative period's CLOSING cash;
      // its own comparative would be the closing cash of the period before
      // that, and `PackFigureSet` carries two windows, not three. Left
      // undeclared the renderer printed `–` in all three cells — a measured
      // nil prior, a measured nil change and a measured nil percentage —
      // against an actual of (125).
      priorUnavailable: 'The period before the comparative period is not in this pack, so there is '
        + 'no earlier opening cash balance to measure this one against.',
    },
    { label: 'Operating cash flow', key: 'cash.operating', source: 'packFigureSet.current.operatingCashFlow', actual: current.operatingCashFlow ?? null, prior: prior?.operatingCashFlow ?? null, unavailable: absentOperatingCashFlow(current), priorUnavailable: prior === null ? undefined : absentComparativeCashFlow(prior, current) },
    { label: 'Investing cash flow', key: 'cash.investing', source: 'packStatementTables.investingCashFlow', actual: investing(current), prior: prior ? investing(prior) : null, // THE REASON NAMES THIS ROW'S OWN NOUN, as the two beside it do. It read
    // "Investing cash flow is taken from capital expenditure, and no capital
    // expenditure figure was captured" — true while this row was capex
    // negated and nothing else. It is net investing from the cash flow
    // statement now, with capex as the fallback, so a sentence equating the
    // two would be false on every pack that has the statement's figure.
    unavailable: notRead ?? 'No investing cash flow figure was captured for this period.', priorUnavailable: priorNotRead },
    { label: 'Financing cash flow', key: 'cash.financing', source: 'packFigureSet.current.financingCashFlow', actual: current.financingCashFlow ?? null, prior: prior?.financingCashFlow ?? null, unavailable: notRead ?? 'No financing cash flow figure was captured for this period.', priorUnavailable: priorNotRead },
    { label: 'Closing cash', key: 'cash.closing', source: 'packFigureSet.current.cash', role: 'total', actual: current.cash, prior: prior?.cash ?? null },
  ], set, false);
}

