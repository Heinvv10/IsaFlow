/**
 * Engagement Budget figures for one job: budget, used, balance and hours.
 * Read-only. Amber from 80% used, red once over (negative balance); a job with
 * no budget says "No budget", never R0. Shared by the time entry form and the
 * job detail page.
 */
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import type { JobBudgetState, JobBudgetStatus } from '@/modules/accounting/services/practice/practiceJobBudget';

/** Rand, with the sign in front of the symbol: "-R 900.00", never "R -900.00". */
export const fmtRand = (v: number) => (v < 0 ? `-${formatCurrencyAmount(-v, 'ZAR')}` : formatCurrencyAmount(v, 'ZAR'));

/**
 * Text colour per state, in both themes (the repo's light/dark status pairs).
 * Every pair is at least 4.5:1 on the panel and table backgrounds; the bare
 * -400 shades read 1.5–2.7:1 on white.
 */
export const BUDGET_STATE_TEXT: Record<JobBudgetState, string> = {
  none: 'text-slate-600 dark:text-slate-300',
  ok: 'text-teal-700 dark:text-teal-400',
  warning: 'text-amber-700 dark:text-amber-400',
  over: 'text-red-700 dark:text-red-400',
};

/** Small-caps labels: --ff-text-secondary is 4.4:1 on the light panel, under AA. */
const LABEL = 'text-[10px] tracking-[0.12em] font-semibold text-slate-600 dark:text-slate-300 uppercase';

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
      <div className={LABEL}>{label}</div>
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
        <Figure label="Engagement Budget" value={budgetAmount != null ? fmtRand(budgetAmount) : 'No budget'}
          cls={budgetAmount != null ? undefined : BUDGET_STATE_TEXT.none} />
        <Figure label="Used" value={`${fmtRand(consumedAmount)}${percentUsed != null ? ` (${percentUsed.toFixed(1)}%)` : ''}`} />
        <Figure label="Engagement Budget Balance" value={balance != null ? fmtRand(balance) : 'No budget'}
          cls={BUDGET_STATE_TEXT[state]} />
        <Figure label="Hours used" value={hours} />
      </div>
      {state === 'warning' && <p className={`mt-2 text-xs ${BUDGET_STATE_TEXT.warning}`}>80% or more of this engagement&apos;s budget is used.</p>}
      {state === 'over' && <p className={`mt-2 text-xs ${BUDGET_STATE_TEXT.over}`}>This engagement is over budget. Time can still be saved.</p>}
    </div>
  );
}
