/**
 * WorkItemManager — list, add and activate/deactivate the work items inside one
 * job category. Rendered inside an expanded category row on the Job Categories
 * page.
 *
 * `POST /api/accounting/practice/work-items` existed from the start but had no
 * caller anywhere in the app, and `seedDefaultCategories` seeds categories only
 * — so a real practice ended up with categories and zero work items, and the
 * required Work Item field on the time-entry form could never be satisfied.
 * This component is the missing half of that setup flow.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Loader2, AlertCircle, Plus } from 'lucide-react';
import {
  fetchWorkItems,
  createWorkItem,
  setWorkItemActive,
  type WorkItem,
} from './practiceApi';

const PILL_CLS = 'text-xs font-medium px-2 py-0.5 rounded-full';

function BillablePill({ billable }: { billable: boolean }) {
  return (
    <span className={`${PILL_CLS} ${billable
      ? 'bg-teal-500/20 text-teal-400'
      : 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)]'}`}
    >
      {billable ? 'Billable' : 'Non-billable'}
    </span>
  );
}

function WorkItemRow({ item, onToggle }: { item: WorkItem; onToggle: (i: WorkItem) => Promise<void> }) {
  const [busy, setBusy] = useState(false);

  async function handleToggle() {
    setBusy(true);
    try { await onToggle(item); } finally { setBusy(false); }
  }

  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <span className={`text-sm flex-1 ${item.isActive
        ? 'text-[var(--ff-text-primary)]'
        : 'text-[var(--ff-text-tertiary)] line-through'}`}
      >
        {item.name}
      </span>
      <BillablePill billable={item.defaultBillable} />
      <button
        type="button"
        onClick={() => void handleToggle()}
        disabled={busy}
        className={`${PILL_CLS} transition-colors disabled:opacity-50 ${item.isActive
          ? 'bg-teal-500/20 text-teal-400 hover:bg-teal-500/30'
          : 'bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-tertiary)] hover:bg-[var(--ff-bg-secondary)]'}`}
        title={item.isActive ? 'Deactivate — hides it from time entry' : 'Reactivate'}
      >
        {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : (item.isActive ? 'Active' : 'Inactive')}
      </button>
    </li>
  );
}

export function WorkItemManager({ categoryId }: { categoryId: string }) {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const [items, setItems] = useState<WorkItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [billable, setBillable] = useState(true);
  const [isAdding, setIsAdding] = useState(false);

  // Collapsing the category row unmounts this component; a reload triggered by
  // an in-flight add/toggle must not set state afterwards.
  const load = useCallback(async () => {
    setError('');
    try {
      const next = await fetchWorkItems(categoryId, true);
      if (alive.current) setItems(next);
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : 'Failed to load work items');
    } finally {
      if (alive.current) setIsLoading(false);
    }
  }, [categoryId]);

  useEffect(() => { void load(); }, [load]);

  async function handleAdd() {
    const name = newName.trim();
    if (!name) return;
    setIsAdding(true);
    setError('');
    try {
      await createWorkItem(categoryId, name, billable);
      setNewName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add work item');
    } finally {
      setIsAdding(false);
    }
  }

  // Reload rather than patching state locally: the server is the authority on
  // is_active, and a failed PUT must not leave the row looking toggled.
  async function handleToggle(item: WorkItem) {
    setError('');
    try {
      await setWorkItemActive(item.id, !item.isActive);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update work item');
    }
  }

  return (
    <div>
      {isLoading ? (
        <div className="flex items-center gap-2 px-4 py-3 text-[var(--ff-text-tertiary)] text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading work items…
        </div>
      ) : items.length === 0 ? (
        <p className="px-4 py-3 text-sm text-[var(--ff-text-tertiary)]">
          No work items yet. Time entries require one, so add at least one below.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--ff-border-primary)]">
          {items.map((item) => (
            <WorkItemRow key={item.id} item={item} onToggle={handleToggle} />
          ))}
        </ul>
      )}

      {error && (
        <p className="flex items-center gap-2 px-4 py-2 text-red-400 text-sm">
          <AlertCircle className="h-4 w-4 shrink-0" />
          {error}
        </p>
      )}

      <div className="flex items-center gap-3 px-4 py-3 border-t border-[var(--ff-border-primary)]">
        <input
          type="text"
          value={newName}
          maxLength={120}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void handleAdd(); }}
          placeholder="New work item name…"
          className="flex-1 px-3 py-1.5 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] placeholder:text-[var(--ff-text-tertiary)] text-sm focus:outline-none focus:ring-1 focus:ring-teal-500"
        />
        <label className="flex items-center gap-2 cursor-pointer select-none text-sm text-[var(--ff-text-secondary)] whitespace-nowrap">
          <input
            type="checkbox"
            checked={billable}
            onChange={(e) => setBillable(e.target.checked)}
            className="rounded border-[var(--ff-border-primary)] text-teal-500 focus:ring-teal-500"
          />
          Billable
        </label>
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={isAdding || !newName.trim()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isAdding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          Add
        </button>
      </div>
    </div>
  );
}
