/**
 * Engagement Budget figures for one job: budget, used, balance and hours.
 * Read-only. Amber from 80% used, red once over (negative balance); a job with
 * no budget says "No budget", never R0. Shared by the time entry form and the
 * job detail page.
 */
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import type { JobBudgetState, JobBudgetStatus } from '@/modules/accounting/services/practice/practiceJobBudget';

export const fmtRand = (v: number) => formatCurrencyAmount(v, 'ZAR');

/** Text colour per state, as the report and the form both show it. */
export const BUDGET_STATE_TEXT: Record<JobBudgetState, string> = {
  none: 'text-[var(--ff-text-tertiary)]',
  ok: 'text-teal-400',
  warning: 'text-amber-400',
  over: 'text-red-400',
};

export const BUDGET_STATE_LABEL: Record<JobBudgetState, string> = {
  none: 'No budget', ok: 'Within budget', warning: '80%+ used', over: 'Over budget',
};

const BOX: Record<JobBudgetState, string> = {
  none: 'border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)]',
  ok: 'border-[var(--ff-border-primary)] bg-[var(--ff-bg-tertiary)]',
  warning: 'border-amber-500/30 bg-amber-500/10',
  over: 'border-red-500/30 bg-red-500/10',
};

function Figure({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div>
      <div className="text-[10px] tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">{label}</div>
      <div className={`text-sm font-semibold tabular-nums ${cls ?? 'text-[var(--ff-text-primary)]'}`}>{value}</div>
    </div>
  );
}

export function EngagementBudgetSummary({ status }: { status: JobBudgetStatus }) {
  const { budgetAmount, consumedAmount, balance, budgetedHours, hoursUsed, percentUsed, state } = status;
  const hours = budgetedHours != null ? `${hoursUsed.toFixed(2)} of ${budgetedHours.toFixed(2)}h` : `${hoursUsed.toFixed(2)}h`;
  return (
    <div className={`rounded-lg border p-3 ${BOX[state]}`} data-testid="engagement-budget" data-state={state}>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Figure label="Engagement Budget" value={budgetAmount != null ? fmtRand(budgetAmount) : 'No budget'} />
        <Figure label="Used" value={`${fmtRand(consumedAmount)}${percentUsed != null ? ` (${percentUsed.toFixed(1)}%)` : ''}`} />
        <Figure label="Engagement Budget Balance" value={balance != null ? fmtRand(balance) : 'No budget'}
          cls={BUDGET_STATE_TEXT[state]} />
        <Figure label="Hours used" value={hours} />
      </div>
      {state === 'warning' && <p className="mt-2 text-xs text-amber-400">80% or more of this engagement&apos;s budget is used.</p>}
      {state === 'over' && <p className="mt-2 text-xs text-red-400">This engagement is over budget. Time can still be saved.</p>}
    </div>
  );
}
