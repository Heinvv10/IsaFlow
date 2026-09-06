/**
 * One slide. Every figure comes from the pack section or from a comparator
 * service — this component maps, it does not compute.
 */
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import { ProfitWaterfall } from '@/components/accounting/charts/ProfitWaterfall';
import { BudgetBulletRow } from '@/components/accounting/charts/BudgetBulletRow';
import { SmallMultiples } from '@/components/accounting/charts/SmallMultiples';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';
import type { AccountTrends } from '@/modules/accounting/services/reports/trendRowsService';
import { applyBudgetComparator, applyTrend, hasBudgetData } from '@/modules/accounting/services/reports/statementRows/comparators';
import { toIncomeStatementRows } from '@/modules/accounting/services/reports/statementRows/incomeStatementRows';
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.types';
import type { Slide } from './presentSlides';

const COLUMNS = { prior: false, budget: true, variance: true, trend: true } as const;

export function PresentSlide({
  slide, income, trends, budget, budgetedCount,
}: {
  slide: Slide;
  income: IncomeStatementReport | null;
  trends: AccountTrends | null;
  budget: BudgetVsActualLine[];
  /** Mirrors `useStatementComparators`: `applyBudgetComparator` runs only
   *  when a real budget was captured, never on an empty one. */
  budgetedCount: number;
}) {
  if (slide.kind === 'cover') {
    return (
      <div className="flex h-full flex-col justify-center">
        <h1 className="text-5xl font-bold text-[var(--ff-text-primary)]">{slide.title}</h1>
        <p className="mt-4 text-xl text-[var(--ff-text-secondary)]">{String(slide.data['period'] ?? '')}</p>
      </div>
    );
  }

  if (slide.kind === 'income_statement') {
    if (!income) {
      return (
        <p className="text-sm text-[var(--ff-text-secondary)]">
          The income statement for this period could not be loaded.
        </p>
      );
    }
    const base = toIncomeStatementRows(income, { comparative: false });
    const withTrend = trends ? applyTrend(base, trends) : base;
    const rows = hasBudgetData(budgetedCount) ? applyBudgetComparator(withTrend, budget) : withTrend;
    return (
      <>
        <h2 className="mb-4 text-2xl font-semibold text-[var(--ff-text-primary)]">{slide.title}</h2>
        <StatementGrid rows={rows} columns={{ ...COLUMNS }} title="Statement of Comprehensive Income" />
      </>
    );
  }

  if (slide.kind === 'waterfall') {
    const steps = (slide.data['steps'] as WaterfallStep[] | undefined) ?? [];
    return (
      <>
        <h2 className="mb-4 text-2xl font-semibold text-[var(--ff-text-primary)]">{slide.title}</h2>
        <ProfitWaterfall steps={steps} height={420} />
      </>
    );
  }

  if (slide.kind === 'trends' && trends) {
    const panels = Object.entries(trends.byAccountCode)
      .slice(0, 6)
      .map(([key, values]) => ({ key, label: key, values }));
    return (
      <>
        <h2 className="mb-4 text-2xl font-semibold text-[var(--ff-text-primary)]">{slide.title}</h2>
        <SmallMultiples panels={panels} months={trends.months} columns={3} />
      </>
    );
  }

  if (slide.kind === 'ratios' && budget.length > 0) {
    return (
      <>
        <h2 className="mb-4 text-2xl font-semibold text-[var(--ff-text-primary)]">{slide.title}</h2>
        <BudgetBulletRow lines={budget} limit={8} />
      </>
    );
  }

  return (
    <>
      <h2 className="mb-4 text-2xl font-semibold text-[var(--ff-text-primary)]">{slide.title}</h2>
      <p className="text-sm text-[var(--ff-text-secondary)]">
        This section has no presentation renderer yet. Open the pack page for its detail.
      </p>
    </>
  );
}
