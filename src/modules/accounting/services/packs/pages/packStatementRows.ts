/**
 * How a statement table is built from its lines — the comparative cells, the
 * "% of revenue" cell, and the columns a table declares. Split out of
 * `packStatementTables.ts` for the 300-line cap; the two column rules it
 * applies are stated in that file's header.
 */
import { marginPct } from '@/modules/accounting/services/reports/marginPct';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
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

export function buildTable(
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
