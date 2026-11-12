/**
 * OverviewKpiCards: the one KPI row on the dashboard (Cash, Receivables,
 * Payables, Profit this month).
 *
 * Every figure is a headline figure (reports/headlineFigures), the one
 * definition Month-End and the bureau client home show too, as at one SAST
 * date. Profit and revenue are month to date. One caption says so.
 *
 * Not loaded (a failed load): every value is the shared placeholder, never
 * R 0.00, with one Retry. The failure itself is said once, by the parent.
 */

import { TrendingUp, Landmark, CreditCard, Receipt, ArrowDown } from 'lucide-react';
import { formatMoney } from '@/lib/money/formatMoney';
import { Money } from '@/components/ui/Money';
import { formatDisplayDate } from '@/utils/dateFormat';
import type { HeadlineFigures } from '@/modules/accounting/services/reports/headlineFigures';

export interface OverviewKpiCardsProps {
  headline: HeadlineFigures | undefined;
  /** The disputed part of overdue receivables, which the ageing donut shows as its own segment. */
  overdueDisputed?: number;
  onRetry?: () => void;
}

// Exact, never abbreviated: a tile is a figure someone reconciles (principle 1).
const fmtExact = (n: number): string => formatMoney(n);

const CARD = 'bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5';
const TITLE = 'text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]';
const VALUE = 'text-xl font-bold tabular-nums text-[var(--ff-text-primary)]';
const NEGATIVE = 'text-rose-600 dark:text-rose-400';

const TITLES: Array<[string, React.ElementType]> = [
  ['Cash', Landmark], ['Receivables', CreditCard], ['Payables', Receipt], ['Profit this month', TrendingUp],
];

function CardHead({ title, icon: Icon }: { title: string; icon: React.ElementType }) {
  return (
    <div className="flex items-center justify-between mb-1">
      <span className={TITLE}>{title}</span>
      <Icon className="h-4 w-4 text-teal-500" />
    </div>
  );
}

function Unloaded({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {TITLES.map(([title, icon]) => (
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

function OverdueLine({ amount }: { amount: number }) {
  return amount > 0
    ? <p className={`text-xs mt-1 ${NEGATIVE}`}>{fmtExact(amount)} overdue</p>
    : <p className="text-xs mt-1 text-teal-500">No overdue</p>;
}

export function OverviewKpiCards({ headline, overdueDisputed = 0, onRetry }: OverviewKpiCardsProps) {
  if (!headline) return <Unloaded onRetry={onRetry} />;
  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--ff-text-tertiary)]">
        As at {formatDisplayDate(headline.asAt)}. Posted entries only. Profit and revenue are for the month to date.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className={CARD}>
          <CardHead title="Cash" icon={Landmark} />
          <p className={`text-xl font-bold tabular-nums flex items-center gap-1.5 ${headline.cash < 0 ? NEGATIVE : 'text-[var(--ff-text-primary)]'}`}>
            {headline.cash < 0 && <ArrowDown className="h-5 w-5" aria-label="Negative" />}
            {fmtExact(headline.cash)}
          </p>
          <p className="text-xs mt-1 text-[var(--ff-text-tertiary)]">Per the ledger</p>
        </div>
        <div className={CARD}>
          <CardHead title="Receivables" icon={CreditCard} />
          <p className={VALUE}>{fmtExact(headline.receivables.total)}</p>
          <OverdueLine amount={headline.receivables.overdue} />
          {overdueDisputed > 0 && (
            <p className="text-xs text-[var(--ff-text-tertiary)]">of which {fmtExact(overdueDisputed)} disputed</p>
          )}
        </div>
        <div className={CARD}>
          <CardHead title="Payables" icon={Receipt} />
          <p className={VALUE}>{fmtExact(headline.payables.total)}</p>
          <OverdueLine amount={headline.payables.overdue} />
        </div>
        <div className={CARD}>
          <CardHead title="Profit this month" icon={TrendingUp} />
          <p className={`text-xl font-bold tabular-nums ${headline.profitMtd < 0 ? NEGATIVE : 'text-[var(--ff-text-primary)]'}`}>
            {fmtExact(headline.profitMtd)}
          </p>
          <p className="text-xs mt-1 text-[var(--ff-text-tertiary)]">Revenue {fmtExact(headline.revenueMtd)} this month</p>
        </div>
      </div>
    </div>
  );
}
