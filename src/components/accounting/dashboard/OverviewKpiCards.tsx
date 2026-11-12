/**
 * OverviewKpiCards: the four headline KPI cards on the /accounting overview.
 *
 * Cash and Receivables are the headline figures (reports/headlineFigures), the
 * one definition /home and Month-End show, as at one SAST date. Revenue and Net
 * Profit span the dashboard period. A caption above the cards says which is which.
 *
 * Not loaded (a failed load): every value is the shared placeholder, never
 * R 0.00, with one Retry. The failure itself is said once, by the parent.
 */

import { TrendingUp, Landmark, CreditCard, DollarSign, ArrowDown } from 'lucide-react';
import { formatMoney } from '@/lib/money/formatMoney';
import { Money } from '@/components/ui/Money';
import { formatDisplayDate } from '@/utils/dateFormat';

export interface OverviewKpis {
  revenue: { total: number; priorTotal: number; changePercent: number };
  netProfit: { amount: number; margin: number | null };
  /** `overdueDisputed`: the disputed part of `overdue`, which the ageing donut shows as its own segment. */
  receivables: { total: number; overdue: number; overdueDisputed?: number; avgDebtorDays: number };
}

/** The headline figures these cards read (a subset of reports/headlineFigures#HeadlineFigures). */
export interface OverviewHeadline {
  asAt: string;
  cash: number;
  receivables: { total: number; overdue: number };
}

export interface OverviewKpiCardsProps {
  kpis: OverviewKpis | undefined;
  headline: OverviewHeadline | undefined;
  period?: { from: string; to: string };
  onRetry?: () => void;
}

const NO_MARGIN_REASON = 'Not meaningful: no positive revenue in this period';

// Exact, never abbreviated: a tile is a figure someone reconciles (principle 1).
const fmtExact = (n: number): string => formatMoney(n);

const CARD = 'bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5';
const TITLE = 'text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]';
const VALUE = 'text-xl font-bold tabular-nums text-[var(--ff-text-primary)]';

function CardHead({ title, icon: Icon }: { title: string; icon: React.ElementType }) {
  return (
    <div className="flex items-center justify-between mb-1">
      <span className={TITLE}>{title}</span>
      <Icon className="h-4 w-4 text-teal-500" />
    </div>
  );
}

function Unloaded({ onRetry }: { onRetry?: () => void }) {
  const titles: Array<[string, React.ElementType]> = [
    ['Revenue', TrendingUp], ['Net Profit', DollarSign], ['Cash', Landmark], ['Receivables', CreditCard],
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {titles.map(([title, icon]) => (
          <div key={title} className={CARD}>
            <CardHead title={title} icon={icon} />
            <p className={VALUE}><Money /><span className="sr-only">not loaded</span></p>
          </div>
        ))}
      </div>
      {/* The page or tab above already says the load failed: no second message, just the way out. */}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border border-[var(--ff-border-light)] px-3 py-1 text-xs font-medium text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-tertiary)]"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function OverviewKpiCards({ kpis, headline, period, onRetry }: OverviewKpiCardsProps) {
  if (!kpis || !headline) return <Unloaded onRetry={onRetry} />;
  const asAt = formatDisplayDate(headline.asAt);
  const overdueDisputed = kpis.receivables.overdueDisputed ?? 0;
  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--ff-text-tertiary)]">
        {period && <>Revenue and net profit: {formatDisplayDate(period.from)} to {formatDisplayDate(period.to)}. </>}
        Cash and receivables: as at {asAt}, posted entries only.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className={CARD}>
          <CardHead title="Revenue" icon={TrendingUp} />
          <p className={VALUE}>{fmtExact(kpis.revenue.total)}</p>
          <p className={`text-xs mt-1 ${kpis.revenue.changePercent >= 0 ? 'text-teal-500' : 'text-rose-600 dark:text-rose-400'}`}>
            {kpis.revenue.changePercent >= 0 ? '+' : ''}{kpis.revenue.changePercent.toFixed(1)}% vs prior period
          </p>
        </div>
        <div className={CARD}>
          <CardHead title="Net Profit" icon={DollarSign} />
          <p className={VALUE}>{fmtExact(kpis.netProfit.amount)}</p>
          {kpis.netProfit.margin == null
            ? (
              <p className="text-xs mt-1 text-[var(--ff-text-tertiary)]">
                Net margin: <Money aria-hidden="true" />{' '}
                <span className="text-[var(--ff-text-secondary)]">{NO_MARGIN_REASON}</span>
              </p>
            )
            : <p className="text-xs mt-1 text-[var(--ff-text-tertiary)]">Net margin: {kpis.netProfit.margin.toFixed(1)}%</p>}
        </div>
        <div className={CARD}>
          <CardHead title="Cash" icon={Landmark} />
          <p className={`text-xl font-bold tabular-nums flex items-center gap-1.5 ${headline.cash < 0 ? 'text-rose-600 dark:text-rose-400' : 'text-[var(--ff-text-primary)]'}`}>
            {headline.cash < 0 && <ArrowDown className="h-5 w-5" aria-label="Negative" />}
            {fmtExact(headline.cash)}
          </p>
          <p className="text-xs mt-1 text-[var(--ff-text-tertiary)]">Per the ledger, as at {asAt}</p>
        </div>
        <div className={CARD}>
          <CardHead title="Receivables" icon={CreditCard} />
          <p className={VALUE}>{fmtExact(headline.receivables.total)}</p>
          {headline.receivables.overdue > 0
            ? <p className="text-xs mt-1 text-rose-600 dark:text-rose-400">{fmtExact(headline.receivables.overdue)} overdue</p>
            : <p className="text-xs mt-1 text-teal-500">No overdue</p>}
          {overdueDisputed > 0 && (
            <p className="text-xs text-[var(--ff-text-tertiary)]">of which {fmtExact(overdueDisputed)} disputed</p>
          )}
        </div>
      </div>
    </div>
  );
}
