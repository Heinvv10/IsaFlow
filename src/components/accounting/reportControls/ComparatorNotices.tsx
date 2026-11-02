/**
 * What the comparator columns could not tell you, said out loud.
 *
 * An empty cell on a statement is a CLAIM: an empty trend cell means the
 * account has no series (retained earnings is the one that does), and an empty
 * budget column means no budget was captured. A fetch that failed produces the
 * same empty cells while meaning something entirely different, so it is named
 * here rather than left to look like a fact about the ledger.
 *
 * The error colour is the pages' own `text-red-400`, not `--ff-unfav`: that
 * token means "this variance moved the wrong way" and borrowing it would make
 * one colour say two things on the same screen.
 */
import { AlertCircle, Info } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { budgetElsewhereNotice, noBudgetYearNotice } from '@/modules/accounting/services/budgets/tracking/trackingNoticeText';
import type { BudgetInfo, BudgetState } from './useStatementComparators';

export type { BudgetInfo } from './useStatementComparators';

export const BUDGET_NONE =
  'No budget has been captured for this period, so the Budget column is empty. Capture one under Accounting → Budgets.';
export const BUDGET_FAILED =
  'The budget could not be loaded, so the Budget column is empty. This is a loading failure, not a statement about the period — reload to try again.';
export const BUDGET_WHOLE_MONTHS =
  'Budgets are set by whole month. Choose a window from the 1st to a month end to compare.';
export const COMPANY_WIDE_UNAVAILABLE =
  'A reporting dimension is selected. The 12-month trend is a company-wide figure, so that column is switched off rather than printed beside a filtered figure. Clear the dimension filters to use it.';
export const TREND_FAILED =
  'The 12-month trend could not be loaded, so the trend column is empty. This is a loading failure, not a statement about these accounts — reload to try again.';

/** `retry`: the notice is a refusal the reader can retry. */
export interface ComparatorNotice { tone: 'error' | 'info'; text: string; retry?: true }

export interface ComparatorNoticeState {
  budgetState: BudgetState;
  trendFailed: boolean;
  /** A dimension is selected, so the company-wide trend is withheld. */
  companyWideUnavailable?: boolean;
  /** What the budget fetch said about the window beyond its lines. */
  budget?: BudgetInfo;
}

/** The limiter's wait in words; the shared withAuth limiter sends none, and it resets within a minute. */
function waitWords(secs: number | null): string {
  if (secs === null) return 'about a minute';
  if (secs < 60) return `${secs} second${secs === 1 ? '' : 's'}`;
  const mins = Math.ceil(secs / 60);
  return `${mins} minute${mins === 1 ? '' : 's'}`;
}

/** Budget set above the filter, per polarity: income and expense are never summed into one figure. */
function unallocatedText(u: { income: number; expense: number }): string | null {
  const parts = [
    u.income !== 0 ? `${formatCurrency(u.income)} of income budget` : null,
    u.expense !== 0 ? `${formatCurrency(u.expense)} of expense budget` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return null;
  return `${parts.join(' and ')} on these accounts is set at company level or above this filter and is not split, so the Budget column leaves it out. Clear the dimension filters to see it.`;
}

/** Pure: the notices a given comparator state warrants, in reading order. */
export function comparatorNotices(
  { budgetState, trendFailed, companyWideUnavailable = false, budget }: ComparatorNoticeState,
): ComparatorNotice[] {
  const out: ComparatorNotice[] = [];
  // First: it explains why the trend checkbox below is greyed out.
  if (companyWideUnavailable) out.push({ tone: 'info', text: COMPANY_WIDE_UNAVAILABLE });
  if (trendFailed) out.push({ tone: 'error', text: TREND_FAILED });
  if (budgetState === 'failed') out.push({ tone: 'error', text: BUDGET_FAILED });
  if (budgetState === 'refused') {
    // The server's own reason (the window is not one it will read): no advice to reload, it cannot help.
    out.push({ tone: 'error', text: `The Budget column is empty. ${(budget?.rejection ?? 'The window was refused').replace(/\.$/, '')}.` });
  }
  if (budgetState === 'limited') {
    out.push({ tone: 'error', text: `Too many report requests, so the Budget column is empty: try again in ${waitWords(budget?.retryAfterSecs ?? null)}.`, retry: true });
  }
  if (budgetState !== 'none' && budgetState !== 'available') return out;
  const unallocated = budget?.unallocatedBudget ? unallocatedText(budget.unallocatedBudget) : null;
  const partial = budget?.partialBudgetCount ?? 0;
  const outside = budget?.budgetOutsideFilterYears ?? [];
  if (budgetState === 'none') {
    // A window with no budget in one of its years, a budget only above the filter, or only for part
    // of the window is not "no budget captured": the sentences below say which it is.
    if (budget?.splitsMonth) {
      out.push({ tone: 'info', text: BUDGET_WHOLE_MONTHS });
    } else if (budget && budget.budgetAbsentYears.length > 0) {
      for (const fy of budget.budgetAbsentYears) out.push({ tone: 'info', text: noBudgetYearNotice(fy) });
    } else if (unallocated === null && partial === 0 && outside.length === 0) {
      out.push({ tone: 'info', text: BUDGET_NONE });
    }
  }
  // A year that has a budget, none of it at this filter: not "no budget" (it is set at other cost centres).
  if (outside.length > 0 && !budget?.splitsMonth) {
    for (const fy of outside) out.push({ tone: 'info', text: budgetElsewhereNotice(fy) });
  }
  if (unallocated !== null) out.push({ tone: 'info', text: unallocated });
  if (partial > 0) {
    out.push({ tone: 'info', text: partial === 1
      ? '1 account has a budget for only part of this window; its Budget is blank.'
      : `${partial} accounts have a budget for only part of this window; their Budget is blank.` });
  }
  return out;
}

export function ComparatorNotices(props: ComparatorNoticeState & { onRetryBudget?: () => void }) {
  const notices = comparatorNotices(props);
  if (notices.length === 0) return null;
  return (
    <div className="space-y-1">
      {notices.map(n => (
        <p key={n.text}
          role={n.tone === 'error' ? 'alert' : undefined}
          className={`flex items-start gap-1.5 text-xs ${n.tone === 'error'
            ? 'text-red-400'
            : 'text-[var(--ff-text-tertiary)]'}`}>
          {n.tone === 'error'
            ? <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            : <Info className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />}
          <span>{n.text}</span>
          {n.retry && props.onRetryBudget && (
            <button type="button" onClick={props.onRetryBudget}
              className="ml-1 px-2 py-0.5 rounded border border-[var(--ff-border-light)] text-xs font-medium text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)]">
              Retry
            </button>
          )}
        </p>
      ))}
    </div>
  );
}
