/**
 * What the Budget vs Actual report says about itself (budgets P3 spec §2.2–§2.5):
 * the window and version it read, the in-progress month and how far its
 * actuals are posted, and the engine's notices — no budget for a year in the
 * window, unbudgeted actuals, budgets covering part of the window, and the
 * budget set above the filter (never split; "View unfiltered" clears it).
 * Every figure is the engine's; this file only words them.
 */
import { longDate, monthLabel } from '@/components/accounting/budgets/budgetClient';
import { formatMoney } from '@/lib/money/formatMoney';
import type { BudgetTrackingReport, ByPolarity, TrackingProjectionInfo } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { unbudgetedActualsTo } from '@/modules/accounting/services/budgets/tracking/trackingProjection';

const NOTE = 'text-xs text-[var(--ff-text-secondary)]';
const BOX = 'rounded-lg border px-3 py-2 text-sm';
const AMBER = `${BOX} border-amber-500/40 bg-amber-500/10 text-[var(--ff-text-primary)]`;
const INFO = `${BOX} border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] text-[var(--ff-text-primary)]`;

/** 'October 2026' for '2026-10'. */
const longMonth = (key: string) => longDate(`${key}-01`).replace(/^1 /, '');
const accounts = (n: number) => `${n} account${n === 1 ? '' : 's'}`;

function byPolarity(v: ByPolarity, noun: string): string {
  const parts: string[] = [];
  if (v.income !== 0) parts.push(`${formatMoney(v.income)} of income ${noun}`);
  if (v.expense !== 0) parts.push(`${formatMoney(v.expense)} of expense ${noun}`);
  return parts.join(' and ');
}

/** The Projected FY header's tooltip: which months are actuals and which are budget, and the rule for a
 *  line with no budget (actuals to the month holding today), all from the response. */
export function projectionHeading(p: TrackingProjectionInfo): string {
  const to = unbudgetedActualsTo(p);
  return `${budgetedHeading(p)}; a line with no budget: ${to ? `actuals to ${longDate(to)}` : 'no actuals yet'}`;
}

function budgetedHeading(p: TrackingProjectionInfo): string {
  const fy = `Projected FY${p.fiscalYear}`;
  const budget = p.budgetMonths.length === 0 ? ''
    : p.budgetMonths.length === 1 ? `budget ${monthLabel(p.budgetMonths[0]!)}`
      : `budget ${monthLabel(p.budgetMonths[0]!)}–${monthLabel(p.budgetMonths[p.budgetMonths.length - 1]!)}`;
  if (p.actualMonths.length === 0) return `${fy} = ${budget || 'budget'} (no complete month yet)`;
  const actuals = `actuals to ${longDate(p.cutoff)}`;
  return budget ? `${fy} = ${actuals} + ${budget}` : `${fy} = ${actuals} (the whole year)`;
}

/** The window, the version read, and how far the actuals go. */
export function BudgetTrackingHeader({ report }: { report: BudgetTrackingReport }) {
  const w = report.window;
  const v = report.version;
  const byFy = report.versionsByFy ? Object.entries(report.versionsByFy) : [];
  return (
    <div className="space-y-0.5">
      {!w.notStarted && (
        <p data-testid="report-period" className={NOTE}>{`${w.label}: ${longDate(w.startDate)} to ${longDate(w.endDate)}`}</p>
      )}
      <p data-testid="bva-version-read" className={NOTE}>
        {byFy.length > 0
          ? byFy.map(([fy, x]) => `FY${fy}: ${x.name} · ${x.status}${x.empty ? ' (no budget in this window)' : ''}`).join('; ')
          : v ? `${v.name} · ${v.status}${v.isPrimary ? ' (primary)' : ''}${v.empty ? ' — no budget in this window' : ''}`
            : `No budget version for FY${w.fiscalYear}`}
      </p>
      {!w.notStarted && (
        <p data-testid="posted-through" className={NOTE}>
          {w.inProgress
            ? `${longMonth(w.inProgress.month)} is in progress; ${w.inProgress.actualsTo
              ? `actuals posted through ${longDate(w.inProgress.actualsTo)}` : 'no actuals posted in it yet'}`
            : w.postedThrough ? `Actuals posted through ${longDate(w.postedThrough)}` : 'No actuals posted in this range yet'}
        </p>
      )}
    </div>
  );
}

export function BudgetTrackingNotices({ report, filtered, onViewUnfiltered }: {
  report: BudgetTrackingReport; filtered: boolean; onViewUnfiltered: () => void;
}) {
  const n = report.notices;
  const unallocated = n.unallocatedBudget && (n.unallocatedBudget.income !== 0 || n.unallocatedBudget.expense !== 0)
    ? n.unallocatedBudget : null;
  return (
    <div className="space-y-2">
      {n.noVersionYears.map((fy) => (
        <p key={fy} role="status" data-testid={`bva-no-budget-${fy}`} className={AMBER}>
          {`No budget for FY${fy} in this window: its Budget and variance columns are shown as —, never as zero.`}
        </p>
      ))}
      {n.partialBudget && (
        <p role="status" data-testid="bva-partial-budget" className={AMBER}>
          {`${accounts(n.partialBudget.count)} ${n.partialBudget.count === 1 ? 'is' : 'are'} budgeted for only part of this window (marked ½): their Budget and variance are shown as —.`}
        </p>
      )}
      {n.unbudgetedCount > 0 && (
        <p role="status" data-testid="bva-unbudgeted" className={INFO}>
          {`${accounts(n.unbudgetedCount)} carry actuals with no budget (${byPolarity(n.unbudgetedActual, 'actuals') || 'nil'}).`}
        </p>
      )}
      {unallocated && (
        <div role="status" data-testid="bva-unallocated" className={`${INFO} flex flex-wrap items-center gap-x-3 gap-y-1`}>
          <span>
            {`${byPolarity(unallocated, 'budget')} on these accounts is set above this filter (company level or a coarser cost centre) and is not split.`}
          </span>
          {filtered && (
            <button type="button" onClick={onViewUnfiltered} className="text-sm font-medium text-[var(--ff-brand-eyebrow)] hover:underline">
              View unfiltered →
            </button>
          )}
        </div>
      )}
    </div>
  );
}
