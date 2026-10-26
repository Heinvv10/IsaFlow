/**
 * BankGroupCard — the card for a group of bank sub-accounts (e.g. per-employee
 * paycards under a "Paycards" umbrella account). It sits inline with the
 * primary account cards; the worklist (BankGroupWorklist) renders full-width
 * below the cards row when the group is expanded. "Resume" reopens the
 * sub-account last opened from this group in this browser.
 */

import { CreditCard, ChevronDown, CornerDownRight } from 'lucide-react';
import { formatCurrency as fmtCurrency } from '@/utils/formatters';
import type { BankAccountGroup } from './groupBankAccounts';

interface CardProps {
  group: BankAccountGroup;
  /** True when the currently selected bank account belongs to this group. */
  containsSelection: boolean;
  expanded: boolean;
  onToggle: () => void;
  /** The sub-account last opened from this group, offered as one click; null hides the offer. */
  resume: { id: string; name: string } | null;
  onResume: (id: string) => void;
}

export function BankGroupCard({ group, containsSelection, expanded, onToggle, resume, onResume }: CardProps) {
  const active = containsSelection || expanded;
  const hasGap = Math.abs(group.unreconciledBalance) >= 0.01;
  return (
    <div data-testid="bank-group-card"
      className={`w-[280px] shrink-0 rounded-lg border-2 transition-all ${
        active
          ? 'border-teal-500 bg-teal-500/10 shadow-lg shadow-teal-500/10'
          : 'border-dashed border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] hover:border-[var(--ff-text-tertiary)]'
      }`}>
      <button onClick={onToggle} aria-expanded={expanded} className="block w-full px-4 py-2.5 text-left">
        <div className="flex items-start gap-2">
          <CreditCard className={`mt-0.5 h-4 w-4 shrink-0 ${active ? 'text-teal-600 dark:text-teal-400' : 'text-[var(--ff-text-tertiary)]'}`} />
          <p className={`line-clamp-2 min-w-0 flex-1 text-sm font-semibold leading-snug ${active ? 'text-teal-700 dark:text-teal-400' : 'text-[var(--ff-text-primary)]'}`}
            title={group.groupName}>
            {group.groupName}
          </p>
          <ChevronDown className={`mt-0.5 h-4 w-4 shrink-0 text-[var(--ff-text-tertiary)] transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </div>
        <div className="mt-1 flex items-baseline justify-between gap-2">
          <span className="truncate text-xs text-[var(--ff-text-tertiary)]">
            {group.accounts.length} sub-account{group.accounts.length !== 1 ? 's' : ''}
          </span>
          <span className={`shrink-0 text-sm font-bold tabular-nums ${group.balance >= 0 ? 'text-teal-700 dark:text-teal-400' : 'text-red-700 dark:text-red-300'}`}>
            {fmtCurrency(group.balance)}
          </span>
        </div>
        <div className="mt-0.5 flex items-baseline justify-between gap-2 text-xs text-amber-800 dark:text-amber-400 tabular-nums">
          <span>{group.unallocatedCount > 0 ? `${group.unallocatedCount} open` : ''}</span>
          {hasGap && (
            <span title={`${group.unreconciledCount} unallocated transaction${group.unreconciledCount !== 1 ? 's' : ''} across this group`}>
              Δ&nbsp;{fmtCurrency(Math.abs(group.unreconciledBalance))}
            </span>
          )}
        </div>
      </button>
      {resume && (
        <button onClick={() => onResume(resume.id)} data-testid="bank-group-resume" title={`Resume: ${resume.name}`}
          className="flex w-full items-center gap-1.5 border-t border-[var(--ff-border-light)] px-4 py-1.5 text-left text-xs text-teal-700 dark:text-teal-400 hover:underline">
          <CornerDownRight className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">Resume: {resume.name}</span>
        </button>
      )}
    </div>
  );
}
