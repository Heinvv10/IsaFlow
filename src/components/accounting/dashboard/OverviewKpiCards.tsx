/**
 * OverviewKpiCards — the four headline KPI cards on the Home overview.
 */

import { useId } from 'react';
import { TrendingUp, Landmark, CreditCard, DollarSign, ArrowDown } from 'lucide-react';
import { formatMoney } from '@/lib/money/formatMoney';

export interface OverviewKpis {
  revenue: { total: number; priorTotal: number; changePercent: number };
  netProfit: { amount: number; margin: number | null };
  cash: { total: number; priorTotal: number; change: number };
  /** `overdueDisputed`: the disputed part of `overdue`, which the ageing donut shows as its own segment. */
  receivables: { total: number; overdue: number; overdueDisputed?: number; avgDebtorDays: number };
}

const NO_MARGIN_REASON = 'Not meaningful: no positive revenue in this period';

// Exact, never abbreviated: a tile is a figure someone reconciles (principle 1).
const fmtExact = (n: number): string => formatMoney(n);

export function OverviewKpiCards({ kpis }: { kpis: OverviewKpis | undefined }) {
  const marginReason = useId();
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">Revenue</span>
          <TrendingUp className="h-4 w-4 text-teal-500" />
        </div>
        <p className="text-xl font-bold tabular-nums text-[var(--ff-text-primary)]">{fmtExact(kpis?.revenue.total ?? 0)}</p>
        <p className={`text-xs mt-1 ${(kpis?.revenue.changePercent ?? 0) >= 0 ? 'text-teal-500' : 'text-rose-600 dark:text-rose-400'}`}>
          {(kpis?.revenue.changePercent ?? 0) >= 0 ? '+' : ''}{(kpis?.revenue.changePercent ?? 0).toFixed(1)}% vs prior period
        </p>
      </div>
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">Net Profit</span>
          <DollarSign className="h-4 w-4 text-teal-500" />
        </div>
        <p className="text-xl font-bold tabular-nums text-[var(--ff-text-primary)]">{fmtExact(kpis?.netProfit.amount ?? 0)}</p>
        {!kpis
          // Not loaded: a dash, and no reason (a failed load says nothing about revenue).
          ? <p className="text-xs mt-1 text-[var(--ff-text-tertiary)]">Net margin: —</p>
          : kpis.netProfit.margin == null
            ? (
              <p className="text-xs mt-1 text-[var(--ff-text-tertiary)]" title={NO_MARGIN_REASON} aria-describedby={marginReason}>
                Net margin: —<span id={marginReason} className="sr-only">{NO_MARGIN_REASON}</span>
              </p>
            )
            : <p className="text-xs mt-1 text-[var(--ff-text-tertiary)]">Net margin: {kpis.netProfit.margin.toFixed(1)}%</p>}
      </div>
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">Cash Position</span>
          <Landmark className="h-4 w-4 text-teal-500" />
        </div>
        <p className={`text-xl font-bold tabular-nums flex items-center gap-1.5 ${(kpis?.cash.total ?? 0) < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-[var(--ff-text-primary)]'}`}>
          {(kpis?.cash.total ?? 0) < 0 && <ArrowDown className="h-5 w-5" aria-label="Negative" />}
          {fmtExact(kpis?.cash.total ?? 0)}
        </p>
        <p className={`text-xs mt-1 ${(kpis?.cash.change ?? 0) >= 0 ? 'text-teal-500' : 'text-rose-600 dark:text-rose-400'}`}>
          {(kpis?.cash.change ?? 0) >= 0 ? '+' : ''}{fmtExact(kpis?.cash.change ?? 0)} change
        </p>
      </div>
      <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]">Outstanding AR</span>
          <CreditCard className="h-4 w-4 text-teal-500" />
        </div>
        <p className="text-xl font-bold tabular-nums text-[var(--ff-text-primary)]">{fmtExact(kpis?.receivables.total ?? 0)}</p>
        {(kpis?.receivables.overdue ?? 0) > 0
          ? <p className="text-xs mt-1 text-rose-600 dark:text-rose-400">{fmtExact(kpis?.receivables.overdue ?? 0)} overdue</p>
          : <p className="text-xs mt-1 text-teal-500">No overdue</p>}
        {(kpis?.receivables.overdueDisputed ?? 0) > 0 && (
          <p className="text-xs text-[var(--ff-text-tertiary)]">of which {fmtExact(kpis?.receivables.overdueDisputed ?? 0)} disputed</p>
        )}
      </div>
    </div>
  );
}
