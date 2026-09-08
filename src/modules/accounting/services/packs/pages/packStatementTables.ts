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

import { marginPct } from '@/modules/accounting/services/reports/marginPct';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import { OPERATING_PROFIT_SOURCE, operatingProfitOf } from '@/modules/accounting/services/packs/figures/packMetricReads';
import { PACK_SCALE } from './packBasis';
// The n/m reason a cell prints, shared with page 3's tile captions — see
// `NOT_A_POSITIVE_BASE`. Two wordings of it is how a tile and the table two
// sheets later stop saying the same thing about one figure.
import { NOT_A_POSITIVE_BASE } from '@/modules/accounting/services/packs/narrative/derivedCaptions';
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
  /**
   * Why this row has no prior figure, for a row whose ACTUAL it does have.
   *
   * Required when `prior` is null on a table that prints a prior column —
   * see `buildRow`. A row with no prior and a real actual used to declare no
   * prior/change/change-% figures at all, and `ComparativeTable` prints `–`
   * where a declared column has no figure. The pack defines `–` as a figure
   * MEASURED AND NIL, so page 8's opening cash printed a measured zero prior,
   * a measured zero change and a measured zero percentage against an actual
   * of (125): three cells asserting a movement of nothing where the pack has
   * no movement to state at all.
   */
  priorUnavailable?: string;
}

interface TableOptions {
  /** Revenue for the "% of revenue" column, or null where the table declares
   *  the column but no cell in it can carry a number — see rule 2 above. */
  revenue: number | null;
  /** Whether the table declares a "% of revenue" column at all. False only
   *  where the statement has no such column by design (page 5, 7 and 8). */
  hasPctOfRevenue: boolean;
  /** Whether this table declares prior/change/change-% columns at all. */
  hasPrior: boolean;
}

/**
 * The generic reason a comparative column is empty on a row that has an
 * actual. Rows whose absence has a specific cause supply their own through
 * `RowInput.priorUnavailable`; this is what a row that has not said gets,
 * and it is still a stated reason rather than the em dash that means nil.
 */
const NO_PRIOR_FIGURE =
  'The comparative period carries no figure for this line, so no change can be stated.';

/**
 * Why a "% of revenue" cell carries no number. The base is the CURRENT
 * period's revenue, not a prior figure, so `NOT_A_POSITIVE_BASE` — which says
 * "the prior figure" — would name the wrong number. Two reasons for two
 * bases, rather than one wording that is wrong on one of them.
 *
 * Exported so the test that holds rule 2 asserts the string the sheet prints
 * rather than a copy of it. The rule itself — a declared column whose every
 * cell is `n/m` against a reason, never a column silently removed — had no
 * test at all when it shipped: `checkColumns` fails a HALF-revert in either
 * direction, so each half of it was pinned only by the other, and a clean
 * revert of both was green. See `packPctOfRevenueColumn.test.ts`.
 */
export const REVENUE_NOT_A_POSITIVE_BASE =
  'Revenue for the period is not positive, so a share of it is not meaningful.';

/**
 * The three comparative cells of a row that has no prior figure — printed as
 * `n/m` against a stated reason rather than left undeclared.
 *
 * See `RowInput.priorUnavailable` for why an undeclared cell is not
 * acceptable here: the renderer's fallback for a declared column with no
 * figure is the glyph this pack defines as a measured nil.
 */
function absentPriorFigures(
  p: PackFigureProvenance,
  input: RowInput,
): Partial<Record<PackTableColumnKey, ReturnType<PackFigureProvenance['figure']>>> {
  const reason = input.priorUnavailable ?? NO_PRIOR_FIGURE;
  return {
    prior: p.figure(`${input.source}.prior`, null, 'money', reason),
    change: p.figure(`packStatementTables.change.${input.key}`, null, 'money', reason),
    changePct: p.figure(`packStatementTables.changePct.${input.key}`, null, 'pct', reason),
  };
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
            NOT_A_POSITIVE_BASE,
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

  if (input.actual !== null && opts.hasPrior) {
    Object.assign(figures, input.prior === null
      ? absentPriorFigures(p, input)
      : changeFigures(p, input, input.actual, input.prior));
  }

  // A DECLARED COLUMN ALWAYS CARRIES A FIGURE. The renderer's fallback for a
  // declared column with no figure is the em dash, which this pack defines as
  // a MEASURED NIL — so an omitted cell here would assert a share of nothing
  // rather than say why there is no share to state.
  if (opts.hasPctOfRevenue) {
    const key = `packStatementTables.pctOfRevenue.${input.key}`;
    const pct = opts.revenue === null || input.actual === null
      ? null
      : marginPct(input.actual, opts.revenue);
    if (pct === null) {
      const reason = opts.revenue === null
        ? REVENUE_NOT_A_POSITIVE_BASE
        : input.unavailable ?? 'This line was not captured for the period.';
      figures.pctOfRevenue = p.figure(key, null, 'pct', reason);
    } else {
      figures.pctOfRevenue = p.figure(key, pct, 'pct', undefined, {
        numerator: input.actual!,
        denominator: opts.revenue!,
      });
    }
  }

  return { label: input.label, key: input.key, level: input.level ?? 0, role: input.role ?? 'line', figures };
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
  const hasPrior = set.prior !== null;
  const opts: TableOptions = {
    revenue: usableBase ? revenue : null,
    hasPctOfRevenue: withPctOfRevenue,
    hasPrior,
  };
  return {
    scale: PACK_SCALE,
    columns: columnsFor(hasPrior, withPctOfRevenue),
    rows: inputs.map((input) => buildRow(p, input, opts)),
  };
}

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
    { label: 'Operating cash flow', key: 'cash.operating', source: 'packFigureSet.current.operatingCashFlow', actual: current.operatingCashFlow ?? null, prior: prior?.operatingCashFlow ?? null, unavailable: 'No operating cash flow figure was captured for this period.' },
    { label: 'Investing cash flow', key: 'cash.investing', source: 'packStatementTables.investingCashFlow', actual: investing(current), prior: prior ? investing(prior) : null, // AND THE REASON NAMES THIS ROW'S OWN NOUN FIRST. It read "No capital
    // expenditure figure was captured" under a row labelled Investing cash
    // flow — a reader looks up the marker on one measure and is told about
    // another, and every other reason in the pack names the row it sits on.
    // The capex clause stays because it is the actual cause: this row IS
    // capital expenditure, negated, and nothing else.
    unavailable: 'Investing cash flow is taken from capital expenditure, and no capital expenditure figure was captured for this period.' },
    { label: 'Financing cash flow', key: 'cash.financing', source: 'packFigureSet.current.financingCashFlow', actual: current.financingCashFlow ?? null, prior: prior?.financingCashFlow ?? null, unavailable: 'No financing cash flow figure was captured for this period.' },
    { label: 'Closing cash', key: 'cash.closing', source: 'packFigureSet.current.cash', role: 'total', actual: current.cash, prior: prior?.cash ?? null },
  ], set, false);
}

/**
 * ANCHORING A NUMBERED FOOTNOTE TO THE THING IT IS ABOUT.
 *
 * The pack ran two footnote systems and only the lettered one worked: every
 * `n/m` mark points at its reason, and the numbered notes at the foot of
 * pages 5 to 8 pointed at nothing at all. "Opening cash in the table above is
 * the balance at the START of the reporting period" printed under a table
 * whose Opening cash row carried no marker; "The prior column is the period
 * 26 April 2025 to 31 December 2025" printed under a column heading that said
 * only "Prior".
 *
 * These two stamp the marker on, and they are HERE rather than in the page
 * builder because the page builder is a sequence and this is a fact about a
 * table's shape. They take a predicate rather than a row index for the reason
 * `packStatementIdentities` takes one: a row's position moves with the
 * company's chart of accounts and its ROLE does not.
 *
 * A predicate matching nothing is not silently ignored — see `anchorRow`.
 */
export function anchorRow(
  table: PackTable,
  matches: (row: PackTableRow) => boolean,
  footnote: number,
): PackTable {
  const rows = table.rows.map((row) => (matches(row) ? { ...row, footnote } : row));
  if (rows.every((row, i) => row === table.rows[i])) {
    // A footnote whose anchor does not exist is the defect this function was
    // written to remove, so it fails loudly rather than printing the note
    // unanchored again. Every caller anchors a footnote the page is already
    // printing, so this is unreachable from the composer and is the guard
    // that keeps it so.
    throw new Error(`anchorRow: footnote ${footnote} matched no row of this table`);
  }
  return { ...table, rows };
}

export function anchorColumn(
  table: PackTable,
  column: PackTableColumnKey,
  footnote: number,
): PackTable {
  if (!table.columns.includes(column)) {
    throw new Error(`anchorColumn: footnote ${footnote} names a '${column}' column this table has no`);
  }
  return { ...table, columnNotes: [...(table.columnNotes ?? []), { column, footnote }] };
}
