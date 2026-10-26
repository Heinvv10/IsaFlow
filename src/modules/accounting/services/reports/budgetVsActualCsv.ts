/**
 * The Budget vs Actual CSV, rendered from the SAME row model the screen reads
 * (budgets P0, D3). Pure: no SQL, no re-derived variance, sign or total.
 *
 * Revenue lines, Total revenue, expense lines, Total expenses, Net profit.
 * Variance is the movement (actual − budget) on every row and Variance % its
 * percentage of |budget|; Favourable carries good/bad news. An unbudgeted
 * line's Budget, a null % and an unknown Favourable are empty cells.
 *
 * Text cells go through csvVal (formula-injection guard). Money and % cells
 * are bare `toFixed(2)` numbers we generated: csvVal would prefix a negative
 * figure with `'` and turn it into text in a spreadsheet.
 */

import { csvVal } from '@/lib/csv';
import type { BudgetVsActualLine } from './budgetVsActualLines';
import type { BudgetVsActualSection, BudgetVsActualSections } from './budgetVsActualSections';

export const BUDGET_VS_ACTUAL_CSV_HEADER = 'Section,Account Code,Account Name,Budget,Actual,Variance,Variance %,Favourable';

const money = (n: number) => n.toFixed(2);
const pct = (n: number | null) => (n === null ? '' : n.toFixed(2));
const yesNo = (f: boolean | null) => (f === null ? '' : f ? 'yes' : 'no');

function lineRow(section: string, l: BudgetVsActualLine): string {
  return [
    csvVal(section), csvVal(l.account_code), csvVal(l.account_name),
    l.budgeted ? money(l.budget_amount) : '', money(l.actual_amount), money(l.movement),
    pct(l.movement_pct), yesNo(l.favourable),
  ].join(',');
}

function totalRow(section: string, label: string, s: BudgetVsActualSection): string {
  return [
    csvVal(section), csvVal(''), csvVal(label),
    money(s.budget), money(s.actual), money(s.movement), pct(s.movement_pct), yesNo(s.favourable),
  ].join(',');
}

export function budgetVsActualCsv(result: { lines: BudgetVsActualLine[]; sections: BudgetVsActualSections }): string {
  const out = [BUDGET_VS_ACTUAL_CSV_HEADER];
  for (const l of result.lines.filter((x) => x.account_type === 'revenue')) out.push(lineRow('Revenue', l));
  out.push(totalRow('Revenue', 'Total revenue', result.sections.revenue));
  for (const l of result.lines.filter((x) => x.account_type === 'expense')) out.push(lineRow('Expenses', l));
  out.push(totalRow('Expenses', 'Total expenses', result.sections.expense));
  out.push(totalRow('Net profit', 'Net profit', result.sections.net_profit));
  return out.join('\n');
}
