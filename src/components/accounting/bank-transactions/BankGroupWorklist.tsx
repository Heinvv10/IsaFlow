/**
 * BankGroupWorklist — the expanded list of a bank group's sub-accounts
 * (per-employee paycards). Needs-attention order by default, filter chips
 * with counts, and a header with the group's totals. Sort/filter logic lives
 * in groupWorklistView.ts.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Search, Upload } from 'lucide-react';
import { formatCurrency as fmtCurrency } from '@/utils/formatters';
import { todayInSast } from '@/lib/saDateParser';
import type { BankAccountGroup } from './groupBankAccounts';
import {
  STALE_DAYS, isStale, worklistSummary, worklistView, type WorklistFilter, type WorklistSort,
} from './groupWorklistView';

interface Props {
  group: BankAccountGroup;
  selectedBank: string;
  onSelectBank: (id: string) => void;
}

const CHIPS: { id: WorklistFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'open', label: 'Open' },
  { id: 'stale', label: `Stale >${STALE_DAYS}d` },
  { id: 'none', label: 'No statements' },
];
const SORTS: { id: WorklistSort; label: string }[] = [
  { id: 'attention', label: 'Attention' },
  { id: 'name', label: 'Name' },
  { id: 'balance', label: 'Balance' },
];

const amountClass = (n: number) => (n >= 0 ? 'text-teal-700 dark:text-teal-400' : 'text-red-700 dark:text-red-300');

export function BankGroupWorklist({ group, selectedBank, onSelectBank }: Props) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<WorklistFilter>('all');
  const [sort, setSort] = useState<WorklistSort>('attention');
  const today = todayInSast();
  const view = useMemo(
    () => worklistView(group.accounts, { search, filter, sort, today }),
    [group.accounts, search, filter, sort, today],
  );
  const summary = useMemo(() => worklistSummary(group.accounts, today), [group.accounts, today]);

  // Opening a group scrolls its worklist into view: with many primary cards it renders below the fold.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [group.groupId]);

  return (
    <div ref={ref} data-testid="bank-group-worklist"
      className="mt-3 rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 border-b border-[var(--ff-border-light)] text-xs">
        <span className="font-semibold text-sm text-[var(--ff-text-primary)]">{group.groupName}</span>
        <span className="text-[var(--ff-text-secondary)]">
          Total <span className={`tabular-nums font-semibold ${amountClass(summary.balance)}`}>{fmtCurrency(summary.balance)}</span>
        </span>
        <span className="text-[var(--ff-text-secondary)]" data-testid="bank-group-open-total">
          <span className="tabular-nums font-semibold text-amber-800 dark:text-amber-400">{summary.open}</span> open
        </span>
        <span className="text-[var(--ff-text-secondary)]">
          <span className="tabular-nums font-semibold text-[var(--ff-text-primary)]">{summary.stale}</span> stale
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2 border-b border-[var(--ff-border-light)]">
        <div className="flex items-center gap-2 flex-1 min-w-[12rem]">
          <Search className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={`Search ${group.groupName}…`}
            aria-label={`Search ${group.groupName}`}
            className="flex-1 rounded bg-transparent text-sm text-[var(--ff-text-primary)] placeholder-[var(--ff-text-tertiary)] outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Filter sub-accounts">
          {CHIPS.map(c => (
            <button key={c.id} type="button" onClick={() => setFilter(c.id)} aria-pressed={filter === c.id}
              data-testid={`worklist-chip-${c.id}`}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${filter === c.id
                ? 'border-teal-700 bg-teal-700 text-white'
                : 'border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:border-[var(--ff-text-tertiary)]'}`}>
              {c.label} <span className="tabular-nums">{view.counts[c.id]}</span>
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1 text-xs text-[var(--ff-text-secondary)]">
          Sort
          <select value={sort} onChange={e => setSort(e.target.value as WorklistSort)} data-testid="worklist-sort"
            className="ff-select py-0.5 text-xs">
            {SORTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
      </div>
      <div className="max-h-[28rem] overflow-y-auto divide-y divide-[var(--ff-border-light)]" data-testid="bank-group-rows">
        {view.rows.map(a => {
          const active = a.id === selectedBank;
          const stale = isStale(a.lastDate, today);
          return (
            <div key={a.id} data-testid="bank-group-row"
              className={`flex items-center gap-3 px-3 py-2 text-sm ${active ? 'bg-teal-500/10' : 'hover:bg-[var(--ff-bg-secondary)]'}`}>
              <button onClick={() => onSelectBank(a.id)} aria-current={active ? 'true' : undefined}
                className="flex-1 flex items-center gap-3 text-left min-w-0">
                <span className={`truncate ${active ? 'text-teal-700 dark:text-teal-400 font-semibold' : 'text-[var(--ff-text-primary)]'}`}>
                  {a.accountName}
                </span>
                <span className="text-xs font-mono text-[var(--ff-text-tertiary)] shrink-0">{a.accountCode}</span>
              </button>
              <span className={`tabular-nums text-xs shrink-0 ${amountClass(a.balance)}`}>{fmtCurrency(a.balance)}</span>
              <span data-testid="bank-group-row-open" title="Unallocated transactions"
                className={`text-xs tabular-nums shrink-0 w-14 text-right ${a.unallocatedCount > 0 ? 'text-amber-800 dark:text-amber-400 font-semibold' : 'text-[var(--ff-text-tertiary)]'}`}>
                {a.unallocatedCount} open
              </span>
              <span title="Last imported transaction"
                className={`text-xs shrink-0 w-28 text-right ${stale ? 'text-amber-800 dark:text-amber-400' : 'text-[var(--ff-text-tertiary)]'}`}>
                {a.lastDate ? a.lastDate : 'no statements'}
              </span>
              <Link
                href={`/accounting/bank-reconciliation/import?account_id=${a.id}`}
                className="flex items-center gap-1 text-xs text-teal-700 dark:text-teal-400 hover:underline shrink-0"
                title="Import a statement for this account"
              >
                <Upload className="h-3.5 w-3.5" /> Import
              </Link>
            </div>
          );
        })}
        {view.rows.length === 0 && (
          <p className="px-3 py-4 text-sm text-[var(--ff-text-secondary)] text-center">No matching sub-accounts</p>
        )}
      </div>
    </div>
  );
}
