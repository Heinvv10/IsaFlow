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

/**
 * A slide whose body is a sentence rather than a figure. It still carries the
 * slide's own title: a presenter paging onto a bare line of grey text has no
 * way to tell which section of the pack failed, or was skipped, and the
 * audience sees a slide that looks like a rendering fault.
 */
function SlideNote({ title, children }: { title: string; children: string }) {
  return (
    <>
      <h2 className="mb-4 text-2xl font-semibold text-[var(--ff-text-primary)]">{title}</h2>
      <p className="text-sm text-[var(--ff-text-secondary)]">{children}</p>
    </>
  );
}

/** Account code → account name, from the income statement the deck fetched.
 *  Every band of it, because a trend series is keyed on the code alone. */
function accountNames(income: IncomeStatementReport | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!income) return out;
  for (const line of [
    ...income.revenue, ...income.otherIncome, ...income.costOfSales,
    ...income.operatingExpenses, ...income.otherExpenses,
  ]) {
    if (line.accountCode) out.set(line.accountCode, line.accountName);
  }
  return out;
}

export function PresentSlide({
  slide, income, incomeLoading = false,
  trends, trendsFailed, trendsLoading = false,
  budget, budgetedCount, budgetFailed, budgetLoading = false,
}: {
  slide: Slide;
  income: IncomeStatementReport | null;
  /** The income-statement fetch is in flight. A slide in flight is NOT a
   *  slide that failed, and saying "could not be loaded" over a request that
   *  is still running is a claim nobody checked. */
  incomeLoading?: boolean;
  trends: AccountTrends | null;
  /** The trends fetch rejected. Distinct from "still loading" and from "this
   *  pack has no trends slide" — only this state gets an error message. */
  trendsFailed: boolean;
  /** The trends fetch is in flight. See `incomeLoading`. */
  trendsLoading?: boolean;
  budget: BudgetVsActualLine[];
  /** Mirrors `useStatementComparators`: `applyBudgetComparator` runs only
   *  when a real budget was captured, never on an empty one. */
  budgetedCount: number;
  /** The budget-comparator fetch rejected. Distinct from "no budget was
   *  captured" (`budgetedCount === 0`) — only a real failure gets an error
   *  message here. */
  budgetFailed: boolean;
  /** The budget-comparator fetch is in flight. Distinct from "no budget was
   *  captured", which is a fact about the tenant, not about the request. */
  budgetLoading?: boolean;
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
        <SlideNote title={slide.title}>
          {incomeLoading
            ? 'Loading the income statement for this period…'
            : 'The income statement for this period could not be loaded.'}
        </SlideNote>
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

  if (slide.kind === 'trends') {
    if (trends) {
      // A bare account code names nothing to a room that is not the finance
      // team. The names come off the income statement this deck already
      // fetched; a code with no line there keeps the code alone rather than
      // borrowing a name from somewhere it might not belong.
      const names = accountNames(income);
      const panels = Object.entries(trends.byAccountCode)
        .slice(0, 6)
        .map(([key, values]) => {
          const name = names.get(key);
          return { key, label: name === undefined ? key : `${key} · ${name}`, values };
        });
      return (
        <>
          <h2 className="mb-4 text-2xl font-semibold text-[var(--ff-text-primary)]">{slide.title}</h2>
          <SmallMultiples panels={panels} months={trends.months} columns={3} height={480} />
        </>
      );
    }
    if (trendsLoading) {
      return <SlideNote title={slide.title}>Loading the trend data for this period…</SlideNote>;
    }
    if (trendsFailed) {
      return (
        <SlideNote title={slide.title}>
          The trend data for this period could not be loaded.
        </SlideNote>
      );
    }
  }

  if (slide.kind === 'ratios') {
    // `hasBudgetData` alone. A second `budget.length > 0` here would send a
    // tenant that HAS a budget but no returned line to the "No budget was
    // captured" note, which is then untrue; `BudgetBulletRow` already draws
    // its own "no account carries a budget" copy for an empty list.
    if (hasBudgetData(budgetedCount)) {
      return (
        <>
          <h2 className="mb-4 text-2xl font-semibold text-[var(--ff-text-primary)]">{slide.title}</h2>
          <BudgetBulletRow lines={budget} limit={8} />
        </>
      );
    }
    if (budgetLoading) {
      return <SlideNote title={slide.title}>Loading the budget data for this period…</SlideNote>;
    }
    if (budgetFailed) {
      return (
        <SlideNote title={slide.title}>
          The budget data for this period could not be loaded.
        </SlideNote>
      );
    }
    // budgetedCount === 0 means no budget was captured for this tenant, not
    // that the fetch failed. A bullet chart of every account plotted as
    // unfavourable against a zero target is an artefact of the missing
    // budget, not a finding — say so instead of drawing it.
    return (
      <SlideNote title={slide.title}>
        No budget was captured for this period.
      </SlideNote>
    );
  }

  return (
    <SlideNote title={slide.title}>
      This section has no presentation renderer yet. Open the pack page for its detail.
    </SlideNote>
  );
}
