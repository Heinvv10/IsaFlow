/**
 * The four statement tables of the board pack: results snapshot (page 5),
 * income statement (page 6), financial position (page 7) and cash (page 8).
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
 *   2. Non-positive revenue means no "% of revenue" column. `marginPct`
 *      returns null on a non-positive base for a reason: the sign of the
 *      result stops tracking the sign of the story, so a cost line would
 *      print a flattering positive percentage of a negative turnover.
 */

import { marginPct } from '@/modules/accounting/services/reports/marginPct';
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import { toFinancialData } from './packScorecard';
import { OPERATING_PROFIT_SOURCE, operatingProfitOf } from '@/modules/accounting/services/packs/figures/packMetricReads';
import { PACK_SCALE } from './packBasis';
import type { PackTable, PackTableColumnKey, PackTableRow } from './packPageModel';

/**
 * Spec §7.1 criterion 8's one scale, stated in every table header — the same
 * constant the document's `numberConvention` carries.
 *
 * FIGURES BELOW ARE RAW (R-P52). The scale is a header, and dividing by it is
 * the RENDERER's job through `formatMoney`'s `scale` option. A model that
 * divided would put arithmetic where no service owns it, and would hand the
 * integrity gate a display transform to compare against the ledger.
 */

/** One statement line, before the comparative columns are worked out. */
interface RowInput {
  label: string;
  /** Short key the change/percent sources are named from — unique per table. */
  key: string;
  /** Where the ACTUAL came from: '<serviceCall>.<field>'. */
  source: string;
  level?: 0 | 1 | 2;
  role?: PackTableRow['role'];
  actual: number | null;
  /** Null means this row genuinely has no prior value — the opening cash of a
   *  first period, not a zero. */
  prior: number | null;
  /** Required when `actual` is null. */
  unavailable?: string;
}

interface TableOptions {
  /** Revenue for the "% of revenue" column, or null to omit that column. */
  revenue: number | null;
}

function changeFigures(
  p: PackFigureProvenance,
  input: RowInput,
  actual: number,
  prior: number,
): Partial<Record<PackTableColumnKey, ReturnType<PackFigureProvenance['figure']>>> {
  const change = actual - prior;
  const pct = marginPct(change, prior);
  return {
    prior: p.figure(`${input.source}.prior`, prior, 'money'),
    change: p.figure(`packStatementTables.change.${input.key}`, change, 'money'),
    changePct:
      pct === null
        ? p.figure(
            `packStatementTables.changePct.${input.key}`,
            null,
            'pct',
            'The prior figure is not a positive base, so a percentage change would not track the direction of the movement.',
          )
        : p.figure(`packStatementTables.changePct.${input.key}`, pct, 'pct', undefined, {
            numerator: change,
            denominator: prior,
          }),
  };
}

function buildRow(p: PackFigureProvenance, input: RowInput, opts: TableOptions): PackTableRow {
  const actual =
    input.actual === null
      ? p.figure(input.source, null, 'money', input.unavailable ?? 'This line was not captured for the period.')
      : p.figure(input.source, input.actual, 'money');

  const figures: PackTableRow['figures'] = { actual };

  if (input.prior !== null && input.actual !== null) {
    Object.assign(figures, changeFigures(p, input, input.actual, input.prior));
  }

  if (opts.revenue !== null && input.actual !== null) {
    const pct = marginPct(input.actual, opts.revenue);
    if (pct !== null) {
      figures.pctOfRevenue = p.figure(
        `packStatementTables.pctOfRevenue.${input.key}`,
        pct,
        'pct',
        undefined,
        { numerator: input.actual, denominator: opts.revenue },
      );
    }
  }

  return { label: input.label, level: input.level ?? 0, role: input.role ?? 'line', figures };
}

/** The columns the rows actually carry — declared once, never per cell. */
function columnsFor(hasPrior: boolean, hasPctOfRevenue: boolean): PackTableColumnKey[] {
  const columns: PackTableColumnKey[] = ['actual'];
  if (hasPrior) columns.push('prior', 'change', 'changePct');
  if (hasPctOfRevenue) columns.push('pctOfRevenue');
  return columns;
}

function buildTable(
  p: PackFigureProvenance,
  inputs: RowInput[],
  set: PackFigureSet,
  withPctOfRevenue: boolean,
): PackTable {
  const revenue = withPctOfRevenue ? set.current.revenue : 0;
  // `marginPct` on the revenue line itself is the cheapest honest test of
  // whether the base is usable at all: null here means null for every row.
  const usableBase = withPctOfRevenue && marginPct(set.current.revenue, revenue) !== null;
  const opts: TableOptions = { revenue: usableBase ? revenue : null };
  return {
    scale: PACK_SCALE,
    columns: columnsFor(set.prior !== null, usableBase),
    rows: inputs.map((input) => buildRow(p, input, opts)),
  };
}

const grossProfitOf = (f: ReportPackFigures): number => f.revenue - f.costOfSales;
const ebitdaOf = (f: ReportPackFigures): number => calculateExtendedRatios(toFinancialData(f)).ebitda;


/** Page 5 — the one table every later number traces back to. */
export function buildResultsTable(set: PackFigureSet, p: PackFigureProvenance): PackTable {
  const { current, prior } = set;
  return buildTable(p, [
    { label: 'Revenue', key: 'results.revenue', source: 'packFigureSet.current.revenue', actual: current.revenue, prior: prior?.revenue ?? null },
    { label: 'Gross profit', key: 'results.grossProfit', source: 'packStatementTables.grossProfit', role: 'subtotal', actual: grossProfitOf(current), prior: prior ? grossProfitOf(prior) : null },
    { label: 'Operating profit', key: 'results.operating', source: OPERATING_PROFIT_SOURCE, role: 'subtotal', actual: operatingProfitOf(current), prior: prior ? operatingProfitOf(prior) : null },
    { label: 'EBITDA', key: 'results.ebitda', source: 'calculateExtendedRatios.ebitda', role: 'subtotal', actual: ebitdaOf(current), prior: prior ? ebitdaOf(prior) : null },
    { label: 'Net profit', key: 'results.netProfit', source: 'packFigureSet.current.netProfit', role: 'total', actual: current.netProfit, prior: prior?.netProfit ?? null },
  ], set, false);
}

/** Page 6 — the condensed P&L, six data columns being the ceiling. */
export function buildIncomeStatementTable(set: PackFigureSet, p: PackFigureProvenance): PackTable {
  const { current, prior } = set;
  return buildTable(p, [
    { label: 'Revenue', key: 'is.revenue', source: 'packFigureSet.current.revenue', actual: current.revenue, prior: prior?.revenue ?? null },
    { label: 'Cost of sales', key: 'is.costOfSales', source: 'packFigureSet.current.costOfSales', level: 1, actual: current.costOfSales, prior: prior?.costOfSales ?? null },
    { label: 'Gross profit', key: 'is.grossProfit', source: 'packStatementTables.grossProfit', role: 'subtotal', actual: grossProfitOf(current), prior: prior ? grossProfitOf(prior) : null },
    { label: 'Operating expenses', key: 'is.operatingExpenses', source: 'packFigureSet.current.operatingExpenses', level: 1, actual: current.operatingExpenses, prior: prior?.operatingExpenses ?? null },
    { label: 'Other income', key: 'is.otherIncome', source: 'packFigureSet.current.otherIncome', level: 1, actual: current.otherIncome ?? 0, prior: prior?.otherIncome ?? null },
    { label: 'Other expenses', key: 'is.otherExpenses', source: 'packFigureSet.current.otherExpenses', level: 1, actual: current.otherExpenses ?? 0, prior: prior?.otherExpenses ?? null },
    { label: 'Operating profit', key: 'is.operating', source: OPERATING_PROFIT_SOURCE, role: 'subtotal', actual: operatingProfitOf(current), prior: prior ? operatingProfitOf(prior) : null },
    { label: 'Net profit', key: 'is.netProfit', source: 'packFigureSet.current.netProfit', role: 'total', actual: current.netProfit, prior: prior?.netProfit ?? null },
  ], set, true);
}

/** Page 7 — the position, current/non-current split on both sides. */
export function buildPositionTable(set: PackFigureSet, p: PackFigureProvenance): PackTable {
  const { current, prior } = set;
  const nonCurrentAssets = (f: ReportPackFigures): number => f.totalAssets - f.currentAssets;
  const nonCurrentLiabilities = (f: ReportPackFigures): number => f.totalLiabilities - f.currentLiabilities;
  return buildTable(p, [
    { label: 'Current assets', key: 'sofp.currentAssets', source: 'packFigureSet.current.currentAssets', level: 1, actual: current.currentAssets, prior: prior?.currentAssets ?? null },
    { label: 'Non-current assets', key: 'sofp.nonCurrentAssets', source: 'packStatementTables.nonCurrentAssets', level: 1, actual: nonCurrentAssets(current), prior: prior ? nonCurrentAssets(prior) : null },
    { label: 'Total assets', key: 'sofp.totalAssets', source: 'packFigureSet.current.totalAssets', role: 'subtotal', actual: current.totalAssets, prior: prior?.totalAssets ?? null },
    { label: 'Current liabilities', key: 'sofp.currentLiabilities', source: 'packFigureSet.current.currentLiabilities', level: 1, actual: current.currentLiabilities, prior: prior?.currentLiabilities ?? null },
    { label: 'Non-current liabilities', key: 'sofp.nonCurrentLiabilities', source: 'packStatementTables.nonCurrentLiabilities', level: 1, actual: nonCurrentLiabilities(current), prior: prior ? nonCurrentLiabilities(prior) : null },
    { label: 'Total liabilities', key: 'sofp.totalLiabilities', source: 'packFigureSet.current.totalLiabilities', role: 'subtotal', actual: current.totalLiabilities, prior: prior?.totalLiabilities ?? null },
    { label: 'Total equity', key: 'sofp.totalEquity', source: 'packFigureSet.current.totalEquity', role: 'total', actual: current.totalEquity, prior: prior?.totalEquity ?? null },
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
  // Not `?? 0`: a missing capex figure is an ARTEFACT, not a period with no
  // investing activity, and the two other cash rows already say "not
  // captured" when their figure is absent. R-P44/R-P45's doctrine, applied
  // consistently — a silent zero here would report a company that bought
  // nothing.
  const investing = (f: ReportPackFigures): number | null =>
    f.capitalExpenditure === undefined ? null : -f.capitalExpenditure;
  return buildTable(p, [
    {
      label: 'Opening cash',
      key: 'cash.opening',
      source: 'packFigureSet.prior.cash',
      role: 'subtotal',
      actual: prior?.cash ?? null,
      prior: null,
      unavailable: 'There is no prior period, so no opening cash balance carries forward into this one.',
    },
    { label: 'Operating cash flow', key: 'cash.operating', source: 'packFigureSet.current.operatingCashFlow', actual: current.operatingCashFlow ?? null, prior: prior?.operatingCashFlow ?? null, unavailable: 'No operating cash flow figure was captured for this period.' },
    { label: 'Investing cash flow', key: 'cash.investing', source: 'packStatementTables.investingCashFlow', actual: investing(current), prior: prior ? investing(prior) : null, unavailable: 'No capital expenditure figure was captured for this period.' },
    { label: 'Financing cash flow', key: 'cash.financing', source: 'packFigureSet.current.financingCashFlow', actual: current.financingCashFlow ?? null, prior: prior?.financingCashFlow ?? null, unavailable: 'No financing cash flow figure was captured for this period.' },
    { label: 'Closing cash', key: 'cash.closing', source: 'packFigureSet.current.cash', role: 'total', actual: current.cash, prior: prior?.cash ?? null },
  ], set, false);
}
