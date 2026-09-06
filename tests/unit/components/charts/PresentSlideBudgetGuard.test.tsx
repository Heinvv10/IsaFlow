/**
 * `PresentSlide`'s income-statement slide must mirror
 * `useStatementComparators`'s guard: `applyBudgetComparator` runs only when a
 * real budget was captured (`budgetedCount > 0`), never on an empty one. An
 * unguarded call on a tenant with no budget prints every account against a
 * budget of zero — a full-size unfavourable variance that is an artefact,
 * not a finding.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { PresentSlide } from '@/components/accounting/present/PresentSlide';
import type { Slide } from '@/components/accounting/present/presentSlides';
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.types';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';

afterEach(cleanup);

const SLIDE: Slide = { id: 'is:0', kind: 'income_statement', title: 'Income Statement', data: {} };

const INCOME: IncomeStatementReport = {
  periodStart: '2026-01-01', periodEnd: '2026-01-31',
  revenue: [{ accountCode: '4000', accountName: 'Sales', amount: 900_000 }],
  otherIncome: [], costOfSales: [], operatingExpenses: [], otherExpenses: [],
  totalRevenue: 900_000, totalOtherIncome: 0, totalCostOfSales: 0,
  totalOperatingExpenses: 0, totalOtherExpenses: 0,
  grossProfit: 900_000, operatingProfit: 900_000, netProfit: 900_000,
};

const BUDGET: BudgetVsActualLine[] = [{
  account_code: '4000', account_name: 'Sales', account_type: 'revenue',
  budget_amount: 1_000_000, actual_amount: 900_000, variance: -100_000, variance_pct: -10,
}];

describe('PresentSlide income statement budget guard', () => {
  it('leaves the budget cell empty when budgetedCount is 0, even with budget lines present', () => {
    const { container } = render(
      <PresentSlide slide={SLIDE} income={INCOME} trends={null} trendsFailed={false} budget={BUDGET} budgetedCount={0} budgetFailed={false} />,
    );
    // The column header is always drawn (PresentSlide's COLUMNS is static),
    // but no row may carry the R1,000,000 budget figure — that would be the
    // "full-size unfavourable variance on a tenant with no budget" bug.
    expect(container.textContent).not.toContain('1 000 000');
  });

  it('prints the budget figure when budgetedCount is greater than 0', () => {
    const { container } = render(
      <PresentSlide slide={SLIDE} income={INCOME} trends={null} trendsFailed={false} budget={BUDGET} budgetedCount={1} budgetFailed={false} />,
    );
    expect(container.textContent).toContain('1 000 000');
  });
});

const RATIOS_SLIDE: Slide = { id: 'ratios:0', kind: 'ratios', title: 'Ratios', data: {} };

describe('PresentSlide ratios slide budget guard', () => {
  it('does not draw the bullet chart when budgetedCount is 0, even with a budget line present', () => {
    const { container } = render(
      <PresentSlide
        slide={RATIOS_SLIDE} income={null} trends={null} trendsFailed={false}
        budget={BUDGET} budgetedCount={0} budgetFailed={false}
      />,
    );
    // "Budget variance" is BudgetBulletRow/ChartFrame's title — its absence
    // means no chart of every account plotted as unfavourable against a
    // budget of zero was drawn.
    expect(container.textContent).not.toContain('Budget variance');
    expect(container.textContent).toContain('No budget was captured');
  });

  it('draws the bullet chart when budgetedCount is greater than 0', () => {
    const { container } = render(
      <PresentSlide
        slide={RATIOS_SLIDE} income={null} trends={null} trendsFailed={false}
        budget={BUDGET} budgetedCount={1} budgetFailed={false}
      />,
    );
    expect(container.textContent).toContain('Budget variance');
  });
});
