/**
 * BankTxBankCards — the bank account selector. One fixed-width card per primary
 * account, then one per sub-account group, in a single row that scrolls
 * sideways (with a fade edge) when they overflow. Below it: the expanded
 * group's worklist, the ungrouped-accounts hint, and the selected account's
 * one-line summary (BankTxStatsStrip, WP4b), which sits directly above the page's tabs.
 *
 * With more than SWITCHER_THRESHOLD accounts the row shows only the pinned cards (at most six, pins kept in the card
 * order store) and an "All accounts" combobox finds the rest (WP5).
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
import { SWITCHER_THRESHOLD, pinnedKeys, togglePin } from './bankCardPins';
import { BankAccountSwitcher } from './BankAccountSwitcher';
import { useBankCardOrder } from './useBankCardOrder';
import { notify } from '@/utils/toast';
import type { BankAccountSummary } from './useBankTxSummary';
import type { BankTxTab } from './BankTxTabs';
import type { AllocationFilter } from './useBankTxFilters';
import type { StatusTile } from './bankTxStatusTiles';

interface Props {
  bankAccounts: BankAccountSummary[];
  selectedBank: string;
  /** The list total while the New tab is open with filters narrowing it, else null ("n shown" on the Awaiting tile). */
  shown: number | null;
  onSelectBank: (id: string) => void;
  /** Reloads the summaries (after the ungrouped hint moves some into a group). */
  onAccountsChanged: () => void;
  /** Opens the Provisional tab (the Allocated tile's "incl. n provisional"). */
  onShowProvisional: () => void;
  /** The page's own card-order source, when it needs the order too (one read of the preferences, not two). Absent: this loads its own. */
  cardOrder?: ReturnType<typeof useBankCardOrder>;
  /** The view on screen and the status-tile press (the summary line's tiles are filter toggles). */
  tab: BankTxTab;
  allocationFilter: AllocationFilter;
  onTile: (tile: StatusTile) => void;
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

export function BankTxBankCards({ bankAccounts, selectedBank, shown, onSelectBank, onAccountsChanged, onShowProvisional, cardOrder, tab, allocationFilter, onTile }: Props) {
  const bank = bankAccounts.find(b => b.id === selectedBank);
  const { primaries, groups } = useMemo(() => groupBankAccounts(bankAccounts), [bankAccounts]);
  const hints = useMemo(() => findUngroupedHints(primaries, groups), [primaries, groups]);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const expandedGroup = groups.find(g => g.groupId === expandedGroupId);
  const { ref: rowRef, more: rowMore, measure: measureRow } = useOverflowRight(primaries.length + groups.length);
  const { activeCompany } = useCompany();
  const own = useBankCardOrder(cardOrder ? null : activeCompany?.id); // no company -> no read of its own
  const { order, reorder, reset } = cardOrder ?? own;

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
      key: b.id, label: b.accountName, node: <BankPrimaryCard b={b} active={b.id === selectedBank} onSelect={() => selectPrimary(b.id)} />,
    })),
    ...groups.map(g => ({
      key: `group:${g.groupId}`,
      label: g.groupName,
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
  const allKeys = cards.map(c => c.key);
  const switcher = bankAccounts.length > SWITCHER_THRESHOLD;
  const pinned = switcher ? pinnedKeys(allKeys, order) : allKeys;
  const orderedCards = (switcher ? pinned : applyCardOrder(allKeys, order)).map(k => byKey.get(k)!);
  const selectedCardKey = groups.find(g => g.accounts.some(a => a.id === selectedBank))?.groupId;
  const currentKey = selectedCardKey ? `group:${selectedCardKey}` : selectedBank;
  const shownCards = orderedCards.map(c => ({ ...c, current: c.key === currentKey }));
  const outsideSelection = switcher && !pinned.includes(currentKey) ? bank?.accountName ?? null : null;
  const onTogglePin = (key: string) => {
    const r = togglePin(allKeys, order, key);
    if (r.refused) notify.error(r.refused);
    else if (r.order) void reorder(r.order);
  };

  return (
    <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 pt-2.5 pb-2">
      <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h1 className="text-xl font-bold text-[var(--ff-text-primary)]">Bank Transactions</h1>
        {switcher && (
          <BankAccountSwitcher primaries={primaries} groups={groups} accountCount={bankAccounts.length} selectedBank={selectedBank}
            pinned={new Set(pinned)} outsideSelection={outsideSelection} onTogglePin={onTogglePin}
            onPick={(a, groupId) => (groupId ? openSubAccount(groupId, a.id) : selectPrimary(a.id))} />
        )}
        <p className="text-xs text-[var(--ff-text-secondary)]">
          {orderedCards.length > 1 && 'Drag cards to reorder (or Alt+←/→)'}
          {order && (
            <button type="button" onClick={() => void reset()} data-testid="bank-cards-reset-order"
              className="ml-3 text-teal-700 dark:text-teal-400 hover:underline">
              Reset order
            </button>
          )}
        </p>
      </div>
      <div className="relative min-w-0">
        <div ref={rowRef} onScroll={measureRow} data-testid="bank-cards-row"
          className="flex items-stretch gap-3 overflow-x-auto pb-2">
          <SortableCardRow cards={shownCards} onReorder={keys => void reorder(keys)} />
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

      {bank && <BankTxStatsStrip bank={bank} shown={shown} onShowProvisional={onShowProvisional} tab={tab} allocationFilter={allocationFilter} onTile={onTile} />}
    </div>
  );
}
