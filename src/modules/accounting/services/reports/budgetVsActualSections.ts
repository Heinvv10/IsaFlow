/**
 * Revenue / Expenses / Net profit sections over the Budget vs Actual lines.
 * Pure. Replaces the old revenue + expense "totals", which added the two
 * types together and so meant nothing (D1, D10, D11).
 *
 * Each section's variance follows its own polarity, like a line's: revenue
 * actual − budget, expenses budget − actual, net profit actual − budget.
 * Invariant: net profit variance = Σ line.variance, to the cent.
 */

import { round2 } from '../core/budgetMonths';
import { pctOfBudget, type BudgetVsActualLine } from './budgetVsActualLines';

export type BudgetSectionKey = 'revenue' | 'expense' | 'net_profit';

export interface BudgetVsActualSection {
  key: BudgetSectionKey;
  budget: number;
  actual: number;
  /** Favourably signed, as on a line. */
  variance: number;
  /** actual − budget: the printed sign. */
  movement: number;
  variance_pct: number | null;
  movement_pct: number | null;
  /** null when nothing in the section is budgeted. */
  favourable: boolean | null;
}

export interface BudgetVsActualSections {
  revenue: BudgetVsActualSection;
  expense: BudgetVsActualSection;
  net_profit: BudgetVsActualSection;
}

function section(key: BudgetSectionKey, budget: number, actual: number, budgeted: boolean, expensePolarity: boolean): BudgetVsActualSection {
  const movement = round2(actual - budget);
  const variance = expensePolarity ? round2(budget - actual) : movement;
  return {
    key,
    budget,
    actual,
    variance,
    movement,
    variance_pct: pctOfBudget(variance, budget, budgeted),
    movement_pct: pctOfBudget(movement, budget, budgeted),
    favourable: budgeted ? variance >= 0 : null,
  };
}

function sum(lines: BudgetVsActualLine[], pick: (l: BudgetVsActualLine) => number): number {
  return round2(lines.reduce((s, l) => s + pick(l), 0));
}

export function buildBudgetVsActualSections(lines: BudgetVsActualLine[]): BudgetVsActualSections {
  const rev = lines.filter((l) => l.account_type === 'revenue');
  const exp = lines.filter((l) => l.account_type === 'expense');
  const revBudget = sum(rev, (l) => l.budget_amount);
  const expBudget = sum(exp, (l) => l.budget_amount);
  const revActual = sum(rev, (l) => l.actual_amount);
  const expActual = sum(exp, (l) => l.actual_amount);
  return {
    revenue: section('revenue', revBudget, revActual, rev.some((l) => l.budgeted), false),
    expense: section('expense', expBudget, expActual, exp.some((l) => l.budgeted), true),
    net_profit: section(
      'net_profit',
      round2(revBudget - expBudget),
      round2(revActual - expActual),
      lines.some((l) => l.budgeted),
      false,
    ),
  };
}
