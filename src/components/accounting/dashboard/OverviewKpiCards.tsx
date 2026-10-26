/**
 * OverviewKpiCards — the four headline KPI cards on the Home overview.
 */

import { TrendingUp, Landmark, CreditCard, DollarSign, ArrowDown } from 'lucide-react';
import { formatMoneyCompact } from '@/lib/money/formatMoney';

export interface OverviewKpis {
  revenue: { total: number; priorTotal: number; changePercent: number };
  grossProfit: { amount: number; margin: number };
  cash: { total: number; priorTotal: number; change: number };
  receivables: { total: number; overdue: number; avgDebtorDays: number };
}

const fmtCompact = (n: number): string => formatMoneyCompact(n);

export function OverviewKpiCards({ kpis }: { kpis: OverviewKpis | undefined }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">Revenue</span>
          <TrendingUp className="h-4 w-4 text-teal-500" />
        </div>
        <p className="text-2xl font-bold text-[var(--ff-text-primary)]">{fmtCompact(kpis?.revenue.total ?? 0)}</p>
        <p className={`text-xs mt-1 ${(kpis?.revenue.changePercent ?? 0) >= 0 ? 'text-teal-500' : 'text-rose-600 dark:text-rose-400'}`}>
          {(kpis?.revenue.changePercent ?? 0) >= 0 ? '+' : ''}{(kpis?.revenue.changePercent ?? 0).toFixed(1)}% vs prior period
        </p>
      </div>
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">Gross Profit</span>
          <DollarSign className="h-4 w-4 text-teal-500" />
        </div>
        <p className="text-2xl font-bold text-[var(--ff-text-primary)]">{fmtCompact(kpis?.grossProfit.amount ?? 0)}</p>
        <p className="text-xs mt-1 text-[var(--ff-text-tertiary)]">Margin: {(kpis?.grossProfit.margin ?? 0).toFixed(1)}%</p>
      </div>
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">Cash Position</span>
          <Landmark className="h-4 w-4 text-teal-500" />
        </div>
        <p className={`text-2xl font-bold flex items-center gap-1.5 ${(kpis?.cash.total ?? 0) < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-[var(--ff-text-primary)]'}`}>
          {(kpis?.cash.total ?? 0) < 0 && <ArrowDown className="h-5 w-5" aria-label="Negative" />}
          {fmtCompact(kpis?.cash.total ?? 0)}
        </p>
        <p className={`text-xs mt-1 ${(kpis?.cash.change ?? 0) >= 0 ? 'text-teal-500' : 'text-rose-600 dark:text-rose-400'}`}>
          {(kpis?.cash.change ?? 0) >= 0 ? '+' : ''}{fmtCompact(kpis?.cash.change ?? 0)} change
        </p>
      </div>
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">Outstanding AR</span>
          <CreditCard className="h-4 w-4 text-teal-500" />
        </div>
        <p className="text-2xl font-bold text-[var(--ff-text-primary)]">{fmtCompact(kpis?.receivables.total ?? 0)}</p>
        {(kpis?.receivables.overdue ?? 0) > 0
          ? <p className="text-xs mt-1 text-rose-600 dark:text-rose-400">{fmtCompact(kpis?.receivables.overdue ?? 0)} overdue</p>
          : <p className="text-xs mt-1 text-teal-500">No overdue</p>}
      </div>
    </div>
  );
}
