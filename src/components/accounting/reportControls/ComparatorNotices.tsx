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
import type { BudgetState } from './useStatementComparators';

export const BUDGET_NONE =
  'No budget has been captured for this period, so the Budget column is empty. Capture one under Accounting → Budgets.';
export const BUDGET_FAILED =
  'The budget could not be loaded, so the Budget column is empty. This is a loading failure, not a statement about the period — reload to try again.';
export const COMPANY_WIDE_UNAVAILABLE =
  'A cost centre is selected. The 12-month trend and the budget are company-wide figures — neither is filtered by cost centre — so those columns are switched off rather than printed beside a departmental figure. Clear the cost centre to use them.';
export const TREND_FAILED =
  'The 12-month trend could not be loaded, so the trend column is empty. This is a loading failure, not a statement about these accounts — reload to try again.';

export interface ComparatorNotice { tone: 'error' | 'info'; text: string }

export interface ComparatorNoticeState {
  budgetState: BudgetState;
  trendFailed: boolean;
  /** A cost centre is selected, so the company-wide comparators are withheld
   *  rather than drawn beside a departmental figure. */
  companyWideUnavailable?: boolean;
}

/** Pure: the notices a given comparator state warrants, in reading order. */
export function comparatorNotices(
  { budgetState, trendFailed, companyWideUnavailable = false }: ComparatorNoticeState,
): ComparatorNotice[] {
  const out: ComparatorNotice[] = [];
  // First: it explains why the two checkboxes below are greyed out, and it is
  // the reason the other two notices cannot apply.
  if (companyWideUnavailable) out.push({ tone: 'info', text: COMPANY_WIDE_UNAVAILABLE });
  if (trendFailed) out.push({ tone: 'error', text: TREND_FAILED });
  if (budgetState === 'failed') out.push({ tone: 'error', text: BUDGET_FAILED });
  if (budgetState === 'none') out.push({ tone: 'info', text: BUDGET_NONE });
  return out;
}

export function ComparatorNotices(props: ComparatorNoticeState) {
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
        </p>
      ))}
    </div>
  );
}
