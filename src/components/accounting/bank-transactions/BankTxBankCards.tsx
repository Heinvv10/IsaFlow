/**
 * BankTxBankCards — the bank account selector. One fixed-width card per primary
 * account, then one per sub-account group, in a single row that scrolls
 * sideways (with a fade edge) when they overflow. Below it: the expanded
 * group's worklist, the ungrouped-accounts hint, and the selected account's
 * stats strip, which sits directly above the page's tabs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { formatCurrency as fmtCurrency } from '@/utils/formatters';
import { groupBankAccounts } from './groupBankAccounts';
import { BankGroupCard } from './BankSubAccountGroup';
import { BankGroupWorklist } from './BankGroupWorklist';
import { BankTxStatsStrip } from './BankTxStatsStrip';
import { UngroupedAccountsHint } from './UngroupedAccountsHint';
import { findUngroupedHints } from './ungroupedBankHint';
import { readLastOpened, writeLastOpened } from './lastOpenedSubAccount';

export interface BankAcct {
  id: string;
  accountCode: string;
  accountName: string;
  bankAccountNumber?: string | null;
  balance: number;
  reconciledBalance: number;
  unreconciledBalance: number;
  unreconciledCount: number;
  allocatedCount: number;
  /** Suggested/categorised but no journal posted yet (PRD-11). */
  suggestedCount?: number;
  unallocatedCount: number;
  /** Set when this account is a sub-account (its parent is also a bank account). */
  groupId?: string | null;
  groupName?: string | null;
  groupCode?: string | null;
  /** Date of the most recent imported transaction (YYYY-MM-DD). */
  lastDate?: string | null;
}

type Tab = 'new' | 'reviewed' | 'excluded';

interface Props {
  bankAccounts: BankAcct[];
  selectedBank: string;
  tab: Tab;
  total: number;
  onSelectBank: (id: string) => void;
  /** Reloads the bank accounts (after the ungrouped hint moves some into a group). */
  onAccountsChanged: () => void;
}

/** Whether the row has more cards to its right than it shows. */
function useOverflowRight() {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  const measure = useCallback(() => {
    const el = ref.current;
    setMore(!!el && el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);
  useEffect(() => {
    const el = ref.current;
    measure();
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);
  return { ref, more, measure };
}

export function BankTxBankCards({ bankAccounts, selectedBank, tab, total, onSelectBank, onAccountsChanged }: Props) {
  const bank = bankAccounts.find(b => b.id === selectedBank);
  const { primaries, groups } = useMemo(() => groupBankAccounts(bankAccounts), [bankAccounts]);
  const hints = useMemo(() => findUngroupedHints(primaries, groups), [primaries, groups]);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const expandedGroup = groups.find(g => g.groupId === expandedGroupId);
  const row = useOverflowRight();

  // Deep links (?account_id=) can select a sub-account before any user
  // interaction — auto-expand its group so the selection is visible.
  useEffect(() => {
    const owner = groups.find(g => g.accounts.some(a => a.id === selectedBank));
    if (owner) setExpandedGroupId(prev => prev ?? owner.groupId);
  }, [selectedBank, groups]);

  // Last sub-account opened per group, read after mount (storage is browser-only).
  const [lastOpened, setLastOpened] = useState<Record<string, string>>({});
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const g of groups) {
      const id = readLastOpened(g.groupId);
      if (id) next[g.groupId] = id;
    }
    setLastOpened(next);
  }, [groups]);
  const openSubAccount = (groupId: string, id: string) => {
    writeLastOpened(groupId, id);
    setLastOpened(prev => ({ ...prev, [groupId]: id }));
    setExpandedGroupId(groupId);
    onSelectBank(id);
  };
  const resumeFor = (groupId: string) => {
    const g = groups.find(x => x.groupId === groupId);
    const a = g?.accounts.find(x => x.id === lastOpened[groupId]);
    return a && a.id !== selectedBank ? { id: a.id, name: a.accountName } : null;
  };

  return (
    <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
      <h1 className="text-2xl font-bold text-[var(--ff-text-primary)] mb-3">Bank Transactions</h1>
      <div className="relative min-w-0">
        <div ref={row.ref} onScroll={row.measure} data-testid="bank-cards-row"
          className="flex items-stretch gap-3 overflow-x-auto pb-2">
          {primaries.map(b => {
            const active = b.id === selectedBank;
            const gap = b.unreconciledBalance;
            const hasGap = Math.abs(gap) >= 0.01;
            return (
              <button
                key={b.id}
                data-testid="bank-account-card"
                onClick={() => onSelectBank(b.id)}
                title={b.accountName}
                className={`w-[280px] shrink-0 flex items-stretch gap-3 px-4 py-2.5 rounded-lg border-2 transition-all text-left ${
                  active
                    ? 'border-teal-500 bg-teal-500/10 shadow-lg shadow-teal-500/10'
                    : 'border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)] hover:border-[var(--ff-text-tertiary)]'
                }`}
              >
                <div className={`w-2 rounded-full shrink-0 ${active ? 'bg-teal-500' : 'bg-[var(--ff-border-light)]'}`} />
                <div className="min-w-0 flex-1">
                  <p className={`line-clamp-2 text-sm font-semibold leading-snug ${active ? 'text-teal-700 dark:text-teal-400' : 'text-[var(--ff-text-primary)]'}`}>
                    {b.accountName}
                  </p>
                  <div className="mt-1 flex items-baseline justify-between gap-2">
                    <span className="truncate text-xs text-[var(--ff-text-tertiary)] font-mono">
                      {b.accountCode}{b.bankAccountNumber && ` | ****${b.bankAccountNumber.slice(-4)}`}
                    </span>
                    <span className={`shrink-0 text-sm font-bold tabular-nums ${b.balance >= 0 ? 'text-teal-700 dark:text-teal-400' : 'text-red-700 dark:text-red-300'}`}>
                      {fmtCurrency(b.balance)}
                    </span>
                  </div>
                  <div className="flex items-center justify-end gap-2 mt-0.5">
                    <span className="text-xs text-teal-700 dark:text-teal-400 tabular-nums" title="Allocated to GL entries">
                      ✓ {fmtCurrency(b.reconciledBalance)}
                    </span>
                    {hasGap && (
                      <span
                        className="text-xs text-amber-800 dark:text-amber-400 tabular-nums"
                        title={`${b.unreconciledCount} unallocated transaction${b.unreconciledCount !== 1 ? 's' : ''}`}
                      >
                        Δ&nbsp;{fmtCurrency(Math.abs(gap))}
                      </span>
                    )}
                  </div>
                </div>
              </button>
            );
          })}

          {groups.map(g => (
            <BankGroupCard
              key={g.groupId}
              group={g}
              containsSelection={g.accounts.some(a => a.id === selectedBank)}
              expanded={g.groupId === expandedGroupId}
              onToggle={() => setExpandedGroupId(prev => (prev === g.groupId ? null : g.groupId))}
              resume={resumeFor(g.groupId)}
              onResume={id => openSubAccount(g.groupId, id)}
            />
          ))}
        </div>
        {row.more && (
          <div aria-hidden data-testid="bank-cards-fade"
            className="pointer-events-none absolute inset-y-0 right-0 w-16 bg-gradient-to-l from-[var(--ff-bg-secondary)] to-transparent" />
        )}
      </div>

      {expandedGroup && (
        <BankGroupWorklist group={expandedGroup} selectedBank={selectedBank}
          onSelectBank={id => openSubAccount(expandedGroup.groupId, id)} />
      )}

      <UngroupedAccountsHint hints={hints} onMoved={onAccountsChanged} />

      {bank && <BankTxStatsStrip bank={bank} tab={tab} total={total} />}
    </div>
  );
}
