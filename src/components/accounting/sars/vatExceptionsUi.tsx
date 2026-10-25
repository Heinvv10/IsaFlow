/**
 * Shared UI primitives for the VAT201 pre-filing exceptions panel (item 11,
 * file-size limit — split out of VAT201ExceptionsPanel.tsx). No behaviour
 * change: identical markup/classes to what the panel inlined before.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatMoney } from '@/lib/money/formatMoney';

export const fmt = (n: number) => formatMoney(n);

export const th = 'px-2 py-1.5 text-left text-xs font-semibold text-[var(--ff-text-secondary)] uppercase tracking-wider';
export const td = 'px-2 py-1.5 text-xs text-[var(--ff-text-primary)] whitespace-nowrap';
export const tdNum = `${td} text-right tabular-nums`;

export function Section({ title, count, listed, children }: {
  title: string; count: number; listed: number; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-[var(--ff-border-light)]">
      <button onClick={() => setOpen(!open)}
        className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-[var(--ff-bg-primary)]/40">
        <span className="flex items-center gap-2 text-sm font-medium text-[var(--ff-text-primary)]">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {title}
        </span>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${count > 0 ? 'bg-amber-500/15 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'}`}>
          {count}
        </span>
      </button>
      {open && count > 0 && (
        <div className="px-4 pb-3 overflow-x-auto">
          {children}
          {count > listed && (
            <p className="mt-2 text-xs text-[var(--ff-text-tertiary)]">Showing first {listed} of {count}.</p>
          )}
        </div>
      )}
      {open && count === 0 && (
        <p className="px-4 pb-3 text-xs text-[var(--ff-text-tertiary)]">No issues found.</p>
      )}
    </div>
  );
}

export function VarianceCell({ value }: { value: number }) {
  const off = Math.abs(value) > 0.005;
  return (
    <td className={`${tdNum} font-semibold ${off ? 'text-red-400' : 'text-emerald-400'}`}>
      {fmt(value)}
    </td>
  );
}
