/**
 * BankTxBankCards — the bank account selector. One fixed-width card per primary
 * account, then one per sub-account group, in a single row that scrolls
 * sideways (with a fade edge) when they overflow. Below it: the expanded
 * group's worklist, the ungrouped-accounts hint, and the selected account's
 * stats strip, which sits directly above the page's tabs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCompany } from '@/contexts/CompanyContext';
import { groupBankAccounts } from './groupBankAccounts';
import { BankGroupCard } from './BankSubAccountGroup';
import { BankGroupWorklist } from './BankGroupWorklist';
import { BankTxStatsStrip } from './BankTxStatsStrip';
import { UngroupedAccountsHint } from './UngroupedAccountsHint';
import { findUngroupedHints } from './ungroupedBankHint';
import { readLastOpened, writeLastOpened } from './lastOpenedSubAccount';
import { BankPrimaryCard } from './BankPrimaryCard';
import { SortableCardRow, type SortableCard } from './SortableCardRow';
import { applyCardOrder } from './bankCardOrder';
import { useBankCardOrder } from './useBankCardOrder';

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
function useOverflowRight(cardCount: number) {
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
  // A card added or removed changes scrollWidth without resizing the row itself.
  useEffect(measure, [measure, cardCount]);
  return { ref, more, measure };
}

export function BankTxBankCards({ bankAccounts, selectedBank, tab, total, onSelectBank, onAccountsChanged }: Props) {
  const bank = bankAccounts.find(b => b.id === selectedBank);
  const { primaries, groups } = useMemo(() => groupBankAccounts(bankAccounts), [bankAccounts]);
  const hints = useMemo(() => findUngroupedHints(primaries, groups), [primaries, groups]);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const expandedGroup = groups.find(g => g.groupId === expandedGroupId);
  const { ref: rowRef, more: rowMore, measure: measureRow } = useOverflowRight(primaries.length + groups.length);
  const { activeCompany } = useCompany();
  const { order, save } = useBankCardOrder(activeCompany?.id);

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

  // Choosing a primary account closes any open group, so the group card stops reading as selected.
  const selectPrimary = (id: string) => { setExpandedGroupId(null); onSelectBank(id); };
  const cards: SortableCard[] = [
    ...primaries.map(b => ({
      key: b.id, node: <BankPrimaryCard b={b} active={b.id === selectedBank} onSelect={() => selectPrimary(b.id)} />,
    })),
    ...groups.map(g => ({
      key: `group:${g.groupId}`,
      node: (
        <BankGroupCard
          group={g}
          containsSelection={g.accounts.some(a => a.id === selectedBank)}
          expanded={g.groupId === expandedGroupId}
          onToggle={() => setExpandedGroupId(prev => (prev === g.groupId ? null : g.groupId))}
          resume={resumeFor(g.groupId)}
          onResume={id => openSubAccount(g.groupId, id)}
        />
      ),
    })),
  ];
  const byKey = new Map(cards.map(c => [c.key, c]));
  const orderedCards = applyCardOrder(cards.map(c => c.key), order).map(k => byKey.get(k)!);

  return (
    <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Bank Transactions</h1>
        <p className="text-xs text-[var(--ff-text-secondary)]">
          Drag cards to reorder (or Alt+←/→)
          {order && (
            <button type="button" onClick={() => void save(null)} data-testid="bank-cards-reset-order"
              className="ml-3 text-teal-700 dark:text-teal-400 hover:underline">
              Reset order
            </button>
          )}
        </p>
      </div>
      <div className="relative min-w-0">
        <div ref={rowRef} onScroll={measureRow} data-testid="bank-cards-row"
          className="flex items-stretch gap-3 overflow-x-auto pb-2">
          <SortableCardRow cards={orderedCards} onReorder={save} />
        </div>
        {rowMore && (
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
