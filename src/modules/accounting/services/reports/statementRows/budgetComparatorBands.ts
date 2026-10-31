/**
 * The statement pages' Budget column beyond the account rows (budgets P3
 * PR-C, the lead's R7 ruling), from the comparator's engine figures. Copies
 * only:
 *
 *   - `withBudgetedLines`: an account the engine BUDGETS in the window but the
 *     statement does not list (no actual: the statement prints only movement)
 *     gets a line row with actual 0, in its band's section, so an unspent
 *     budget is seen, as on Budget vs Actual. A band section the statement
 *     omitted (no actuals in it at all) is added with a zero header and total.
 *   - `applyBudgetBands`: each band total and profit row takes the ENGINE's
 *     band budget (`bands`), never a sum of the lines above it; null (a line
 *     under it partial, or the window budget absent) prints as absent "—".
 *     The movement is the row's printed actual less that budget, as for a line
 *     (`baseComparison`, exception 1 in `comparators.ts`).
 *
 * The statement's band ids (`incomeStatementRows`) map one to one onto the
 * engine's band keys; invariant 1 holds the engine's band actual to the income
 * statement's, so the two classify an account alike.
 */
import type { TrackingBandKey, TrackingTotalKey } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import type { TrackedLine } from '../budgetVarianceTracked';
import { baseComparison } from './comparators';
import type { StatementRow } from './statementModel';

type Key = TrackingBandKey | TrackingTotalKey;

/** Statement section key, its label, the row its section is inserted BEFORE when absent, and polarity. */
const SECTION: Record<TrackingBandKey, { id: string; label: string; before: string }> = {
  turnover: { id: 'revenue', label: 'Turnover', before: 'total:grossProfit' },
  cost_of_sales: { id: 'costOfSales', label: 'Cost of Sales', before: 'total:grossProfit' },
  other_income: { id: 'otherIncome', label: 'Other Income', before: 'sec:operatingExpenses' },
  operating_expense: { id: 'operatingExpenses', label: 'Operating Expenses', before: 'total:operatingProfit' },
  other_expense: { id: 'otherExpenses', label: 'Other Expenses', before: 'grand:netProfit' },
};

const ROW_BAND: Record<string, { key: Key; polarity: 'income' | 'expense' }> = {
  'sub:revenue': { key: 'turnover', polarity: 'income' },
  'sub:costOfSales': { key: 'cost_of_sales', polarity: 'expense' },
  'total:grossProfit': { key: 'gross_profit', polarity: 'income' },
  'sub:otherIncome': { key: 'other_income', polarity: 'income' },
  'sub:operatingExpenses': { key: 'operating_expense', polarity: 'expense' },
  'total:operatingProfit': { key: 'operating_profit', polarity: 'income' },
  'sub:otherExpenses': { key: 'other_expense', polarity: 'expense' },
  'grand:netProfit': { key: 'net_profit', polarity: 'income' },
};

export function withBudgetedLines(rows: StatementRow[], lines: readonly TrackedLine[]): StatementRow[] {
  const listed = new Set(rows.map((r) => r.accountCode).filter((c): c is string => c !== undefined));
  const missing = lines.filter((l) => l.budget_verdict === 'budgeted' && !listed.has(l.account_code));
  if (missing.length === 0) return rows;
  const out = [...rows];
  for (const l of missing) {
    const sec = SECTION[l.band];
    const row: StatementRow = { id: `acc:${l.account_code}`, kind: 'line', label: l.account_name, depth: 1, accountCode: l.account_code, actual: 0 };
    let sub = out.findIndex((r) => r.id === `sub:${sec.id}`);
    if (sub < 0) {
      const at = out.findIndex((r) => r.id === sec.before);
      const head: StatementRow = { id: `sec:${sec.id}`, kind: 'section', label: sec.label, depth: 0, actual: 0 };
      const total: StatementRow = { id: `sub:${sec.id}`, kind: 'subtotal', label: `Total ${sec.label}`, depth: 0, actual: 0 };
      out.splice(at < 0 ? out.length : at, 0, head, total);
      sub = out.findIndex((r) => r.id === `sub:${sec.id}`);
    }
    out.splice(sub, 0, row);
  }
  return out;
}

export function applyBudgetBands(rows: StatementRow[], bands: ReadonlyArray<{ key: Key; budget: number | null }>): StatementRow[] {
  const byKey = new Map(bands.map((b) => [b.key, b.budget]));
  return rows.map((row) => {
    const band = ROW_BAND[row.id];
    if (!band || !byKey.has(band.key)) return row;
    const budget = byKey.get(band.key)!;
    if (budget === null) return { ...row, budget: { value: 0, absent: true } };
    return {
      ...row,
      budget: baseComparison(budget, Math.round((row.actual - budget) * 100) / 100,
        (v) => (band.polarity === 'income' ? v >= 0 : v <= 0)),
    };
  });
}
