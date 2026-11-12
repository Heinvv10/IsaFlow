/**
 * The unbilled WIP entries of one practice client, each with a tick box, and a
 * select-all box that shows "some" when part of the list is ticked. Used by
 * the Generate Invoice form.
 */
import { useEffect, useRef } from 'react';
import type { PracticeTimeEntry } from '@/modules/accounting/services/practice/practiceTimeEntryTypes';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';

const TH = 'text-left py-2 px-3 text-xs tracking-widest font-semibold text-[var(--ff-text-secondary)] uppercase';
const TD = 'py-2 px-3 text-sm text-[var(--ff-text-secondary)]';

function SelectAllBox({ state, onChange }: { state: 'none' | 'some' | 'all'; onChange: () => void }) {
  const r = useRef<HTMLInputElement>(null);
  useEffect(() => { if (r.current) r.current.indeterminate = state === 'some'; }, [state]);
  return (
    <input ref={r} type="checkbox" aria-label="Select all entries" checked={state === 'all'} onChange={onChange}
      className="h-4 w-4 rounded accent-teal-500 cursor-pointer" />
  );
}

export interface WipEntryPickTableProps {
  entries: PracticeTimeEntry[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}

export function WipEntryPickTable({ entries, selected, onToggle, onToggleAll }: WipEntryPickTableProps) {
  const count = entries.filter((e) => selected.has(e.id)).length;
  const state = count === 0 ? 'none' : count === entries.length ? 'all' : 'some';
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--ff-border-primary)]">
      <table className="w-full">
        <thead className="bg-[var(--ff-bg-tertiary)]">
          <tr>
            <th className={`${TH} w-10`}><SelectAllBox state={state} onChange={onToggleAll} /></th>
            <th className={`${TH} hidden sm:table-cell`}>Date</th>
            <th className={`${TH} hidden sm:table-cell`}>Category / Work item</th>
            <th className={TH}>Description</th>
            <th className={`${TH} text-right`}>Hours</th>
            <th className={`${TH} hidden text-right sm:table-cell`}>Rate</th>
            <th className={`${TH} text-right`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-t border-[var(--ff-border-primary)]">
              <td className={TD}>
                <input type="checkbox" aria-label={`Select entry ${e.taskDescription}`} checked={selected.has(e.id)}
                  onChange={() => onToggle(e.id)} className="h-4 w-4 rounded accent-teal-500 cursor-pointer" />
              </td>
              <td className={`${TD} hidden whitespace-nowrap sm:table-cell`}>{e.entryDate ? formatDisplayDate(e.entryDate) : ''}</td>
              <td className={`${TD} hidden sm:table-cell`}>{[e.jobCategoryName, e.workItemName].filter(Boolean).join(' / ')}</td>
              <td className={`${TD} text-[var(--ff-text-primary)]`}>{e.taskDescription}</td>
              <td className={`${TD} text-right tabular-nums`}>{Number(e.hours).toFixed(2)}</td>
              <td className={`${TD} hidden text-right tabular-nums sm:table-cell`}>{e.appliedRate != null ? formatMoney(e.appliedRate) : ''}</td>
              <td className={`${TD} text-right tabular-nums text-[var(--ff-text-primary)]`}>{formatMoney(e.lineTotal ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
