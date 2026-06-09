/**
 * BankSubAccountGroup — group card + expandable worklist for bank sub-accounts
 * (e.g. per-employee paycards under a "Paycards" umbrella account).
 * The card sits inline with the primary account cards; the worklist renders
 * full-width below the cards row when the group is expanded.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { CreditCard, ChevronDown, Search, Upload } from 'lucide-react';
import { formatCurrency as fmtCurrency } from '@/utils/formatters';
import type { BankAccountGroup } from './groupBankAccounts';

interface CardProps {
  group: BankAccountGroup;
  /** True when the currently selected bank account belongs to this group. */
  containsSelection: boolean;
  expanded: boolean;
  onToggle: () => void;
}

export function BankGroupCard({ group, containsSelection, expanded, onToggle }: CardProps) {
  const active = containsSelection || expanded;
  const hasGap = Math.abs(group.unreconciledBalance) >= 0.01;
  return (
    <button
      onClick={onToggle}
      className={`flex items-center gap-3 px-4 py-2.5 rounded-lg border-2 transition-all text-left ${
        active
          ? 'border-teal-500 bg-teal-500/10 shadow-lg shadow-teal-500/10'
          : 'border-dashed border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] hover:border-[var(--ff-text-tertiary)]'
      }`}
    >
      <CreditCard className={`h-5 w-5 shrink-0 ${active ? 'text-teal-400' : 'text-[var(--ff-text-tertiary)]'}`} />
      <div>
        <p className={`text-sm font-semibold ${active ? 'text-teal-400' : 'text-[var(--ff-text-primary)]'}`}>
          {group.groupName}
        </p>
        <p className="text-xs text-[var(--ff-text-tertiary)]">
          {group.accounts.length} sub-account{group.accounts.length !== 1 ? 's' : ''}
        </p>
      </div>
      <div className="ml-3 text-right">
        <p className={`text-sm font-bold font-mono ${group.balance >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
          {fmtCurrency(group.balance)}
        </p>
        {hasGap && (
          <span
            className="text-[10px] text-amber-400 font-mono"
            title={`${group.unreconciledCount} unallocated transaction${group.unreconciledCount !== 1 ? 's' : ''} across this group`}
          >
            Δ {fmtCurrency(Math.abs(group.unreconciledBalance))}
          </span>
        )}
      </div>
      <ChevronDown className={`h-4 w-4 shrink-0 text-[var(--ff-text-tertiary)] transition-transform ${expanded ? 'rotate-180' : ''}`} />
    </button>
  );
}

interface WorklistProps {
  group: BankAccountGroup;
  selectedBank: string;
  onSelectBank: (id: string) => void;
}

export function BankGroupWorklist({ group, selectedBank, onSelectBank }: WorklistProps) {
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return group.accounts;
    return group.accounts.filter(a =>
      a.accountName.toLowerCase().includes(q) || a.accountCode.toLowerCase().includes(q),
    );
  }, [group.accounts, search]);

  return (
    <div className="mt-3 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--ff-border-light)]">
        <Search className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={`Search ${group.groupName}…`}
          className="flex-1 bg-transparent text-sm text-[var(--ff-text-primary)] placeholder-[var(--ff-text-tertiary)] outline-none"
        />
        <span className="text-xs text-[var(--ff-text-tertiary)]">{filtered.length} of {group.accounts.length}</span>
      </div>
      <div className="max-h-64 overflow-y-auto divide-y divide-[var(--ff-border-light)]">
        {filtered.map(a => {
          const active = a.id === selectedBank;
          return (
            <div
              key={a.id}
              className={`flex items-center gap-3 px-3 py-2 text-sm ${active ? 'bg-teal-500/10' : 'hover:bg-[var(--ff-bg-secondary)]'}`}
            >
              <button onClick={() => onSelectBank(a.id)} className="flex-1 flex items-center gap-3 text-left min-w-0">
                <span className={`truncate ${active ? 'text-teal-400 font-semibold' : 'text-[var(--ff-text-primary)]'}`}>
                  {a.accountName}
                </span>
                <span className="text-xs font-mono text-[var(--ff-text-tertiary)] shrink-0">{a.accountCode}</span>
              </button>
              <span className={`font-mono text-xs shrink-0 ${a.balance >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                {fmtCurrency(a.balance)}
              </span>
              {a.unallocatedCount > 0 && (
                <span className="text-[10px] font-mono text-amber-400 shrink-0" title="Unallocated transactions">
                  {a.unallocatedCount} open
                </span>
              )}
              <span className="text-xs text-[var(--ff-text-tertiary)] shrink-0 w-28 text-right" title="Last imported transaction">
                {a.lastDate ? a.lastDate : 'no statements'}
              </span>
              <Link
                href={`/accounting/bank-reconciliation/import?account_id=${a.id}`}
                className="flex items-center gap-1 text-xs text-teal-400 hover:text-teal-300 shrink-0"
                title="Import a statement for this account"
              >
                <Upload className="h-3.5 w-3.5" /> Import
              </Link>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <p className="px-3 py-4 text-sm text-[var(--ff-text-secondary)] text-center">No matching sub-accounts</p>
        )}
      </div>
    </div>
  );
}
