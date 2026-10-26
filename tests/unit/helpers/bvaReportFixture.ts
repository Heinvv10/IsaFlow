/**
 * A Budget vs Actual report body built by the REAL row-model builders, so page
 * fixtures cannot drift from the shape the API answers (lines + sections).
 */
import { buildBudgetVsActualLines } from '@/modules/accounting/services/reports/budgetVsActualLines';
import { buildBudgetVsActualSections } from '@/modules/accounting/services/reports/budgetVsActualSections';

export interface BvaFixtureAccount { code: string; name: string; type: 'revenue' | 'expense'; actual: number; budget?: number }

export function bvaBody(accounts: BvaFixtureAccount[], postedThrough: string | null = '2026-10-20') {
  const budgets: Record<string, number> = {};
  for (const a of accounts) if (a.budget !== undefined) budgets[`id-${a.code}`] = a.budget;
  const lines = buildBudgetVsActualLines(
    accounts.map((a) => ({ id: `id-${a.code}`, account_code: a.code, account_name: a.name, account_type: a.type, actual_amount: a.actual })),
    budgets,
  );
  return { lines, sections: buildBudgetVsActualSections(lines), posted_through: postedThrough };
}
