/**
 * What the two budget specs (v-budget-workspace, z-budget-drivers) check before they write anything, and SKIP on when it fails:
 * a version for the year, a turnover and a cost-of-sales line with prior-year actuals, and an operating-expense line. Run
 * after seeding so a company that would make the specs skip quietly is a provisioning failure instead.
 */
import type { Client } from '../../ci/golden-hosted/seed-demo-app';
import { fyLabel } from './provisionDb';

interface GridAccount { id: string; band: string; isActive: boolean; isHeader: boolean }
type Reader = Pick<Client, 'get'>;

export async function budgetProblems(api: Reader, now: Date): Promise<string[]> {
  const year = fyLabel(now);
  const problems: string[] = [];
  const years = await api.get<{ fiscalYear: number }>('/api/accounting/budgets?years_only=1');
  if (years.fiscalYear !== year) problems.push(`the app's current budget year is ${years.fiscalYear}, not ${year}`);
  for (const fy of [year, year + 1]) {
    const { items } = await api.get<{ items: unknown[] }>(`/api/accounting/budget-versions?fiscalYear=${fy}`);
    if (items.length === 0) problems.push(`no budget version for FY${fy}`);
  }
  const grid = await api.get<{ accounts: GridAccount[] }>(`/api/accounting/budget-grid?fiscal_year=${year}`);
  const lines = (band: string) => grid.accounts.filter((a) => a.isActive && !a.isHeader && a.band === band);
  for (const band of ['turnover', 'cost_of_sales', 'operating_expense']) {
    if (lines(band).length === 0) problems.push(`the budget grid for FY${year} has no active ${band} line`);
  }
  const prior = await api.get<{ cells: Array<{ glAccountId: string; amount: number }> }>(`/api/accounting/budget-grid/prior-actuals?fiscal_year=${year}&grain=company`);
  const actuals = new Set(prior.cells.filter((c) => Number(c.amount) !== 0).map((c) => c.glAccountId));
  if (![...lines('turnover'), ...lines('cost_of_sales')].some((a) => actuals.has(a.id))) {
    problems.push(`no turnover or cost-of-sales line has prior-year actuals for FY${year} (the previous financial year holds no posted journal)`);
  }
  return problems;
}
