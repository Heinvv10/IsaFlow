/**
 * BudgetTrackingReport → StatementRow[] (budgets P3). Copy, never derive:
 * every figure is the tracking engine's (`services/budgets/tracking/`), band
 * and profit rows included: the engine computes them, so nothing is summed
 * here and the screen, the CSV and the XLSX print one set of figures.
 *
 * Layout is `incomeStatementRows`': Turnover, Cost of Sales, Gross Profit,
 * Other Income, Operating Expenses, Operating Profit, Other Expenses, Net
 * Profit, a COS / other-income / other-expenses band only when it has lines.
 *
 * `budget.variance` is the engine's movement (actual − budget), the sign every
 * StatementGrid comparator prints (comparators.ts exception 1), and
 * `favourable` its polarity judgement. An unbudgeted row is `absent` ("—", no
 * colour): `{ value: 0, absent: true }` with no variance, so a renderer that
 * does not know `absent` yet prints nothing it could colour.
 *
 * `absent` and `projection` are not on `statementModel.ts` yet: that additive
 * change is PR-B's (spec §3). Until then this module's own row type extends
 * the model, so a `BudgetTrackingRow` is a `StatementRow` to every consumer.
 */
import type { BudgetTrackingReport, TrackingBand, TrackingBandKey, TrackingFigures, TrackingLine } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import type { Comparison, StatementRow } from './statementModel';

export interface TrackingComparison extends Comparison {
  absent?: true;
}

export interface TrackingProjectionCells {
  projected: number;
  fyBudget?: number;
  variance?: number;
  favourable?: boolean;
  absent?: true;
}

export interface BudgetTrackingRow extends StatementRow {
  budget: TrackingComparison;
  projection: TrackingProjectionCells;
  /** Budget set above the filter, never in `budget` (spec §2.4); null while the window budget is absent. */
  unallocatedBudget: number | null;
  /** Line rows only: the account's budget covers part of the window (copied from the engine's line). */
  partialBudget?: boolean;
}

function budgetOf(f: TrackingFigures): TrackingComparison {
  if (f.budget === null || f.variance === null) return { value: 0, absent: true };
  const c: TrackingComparison = { value: f.budget, variance: f.variance };
  if (f.variancePct !== null) c.variancePct = f.variancePct;
  if (f.favourable !== null) c.favourable = f.favourable;
  return c;
}

function projectionOf(f: TrackingFigures): TrackingProjectionCells {
  if (f.fyBudget === null || f.projVariance === null) return { projected: f.projected, absent: true };
  const p: TrackingProjectionCells = { projected: f.projected, fyBudget: f.fyBudget, variance: f.projVariance };
  if (f.projFavourable !== null) p.favourable = f.projFavourable;
  return p;
}

function figureRow(id: string, kind: StatementRow['kind'], label: string, depth: 0 | 1, f: TrackingFigures): BudgetTrackingRow {
  return { id, kind, label, depth, actual: f.actual, budget: budgetOf(f), projection: projectionOf(f), unallocatedBudget: f.unallocatedBudget };
}

const lineRow = (l: TrackingLine): BudgetTrackingRow => ({
  ...figureRow(`acc:${l.accountCode}`, 'line', l.accountName, 1, l), accountCode: l.accountCode, partialBudget: l.partialBudget,
});

export function toBudgetTrackingRows(report: Pick<BudgetTrackingReport, 'lines' | 'bands'>): BudgetTrackingRow[] {
  const bandOf = (key: TrackingBand['key']): TrackingBand => {
    const b = report.bands.find((x) => x.key === key);
    if (!b) throw new Error(`budget tracking report has no ${key} band`);
    return b;
  };
  const rows: BudgetTrackingRow[] = [];
  const section = (key: TrackingBandKey, always: boolean) => {
    const lines = report.lines.filter((l) => l.band === key);
    if (lines.length === 0 && !always) return;
    const b = bandOf(key);
    // The band header carries the band actual, as incomeStatementRows does; the HTML view blanks it.
    rows.push({ id: `sec:${key}`, kind: 'section', label: b.label, depth: 0, actual: b.actual, budget: budgetOf(b), projection: projectionOf(b), unallocatedBudget: b.unallocatedBudget });
    rows.push(...lines.map(lineRow));
    rows.push(figureRow(`sub:${key}`, 'subtotal', `Total ${b.label}`, 0, b));
  };
  const total = (key: 'gross_profit' | 'operating_profit' | 'net_profit') => {
    const b = bandOf(key);
    rows.push(figureRow(`${b.kind === 'grand' ? 'grand' : 'total'}:${key}`, b.kind === 'grand' ? 'grand' : 'total', b.label, 0, b));
  };
  section('turnover', true);
  section('cost_of_sales', false);
  total('gross_profit');
  section('other_income', false);
  section('operating_expense', true);
  total('operating_profit');
  section('other_expense', false);
  total('net_profit');
  return rows;
}
