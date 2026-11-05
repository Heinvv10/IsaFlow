/**
 * Per-contact table of the Due by date report with an expandable invoice
 * drill-down. "No due date" is flagged amber on purpose: that money cannot be
 * placed in time, and a zero-looking column must never hide it.
 */

import { Fragment, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';
import type { DueBucket, DueByDateSide } from '@/modules/accounting/utils/dueByDate';

const BUCKET_LABEL: Record<DueBucket, string> = {
  overdueNow: 'Overdue now',
  dueTodayToDate: 'Due today to date',
  dueLater: 'Due later',
  noDueDate: 'No due date',
};

const NO_DUE_CELL = 'text-amber-700 dark:text-amber-400 bg-amber-500/10';
const th = 'px-4 py-3 text-right';
const num = 'px-4 py-3 text-right tabular-nums';

export function DueByDateTable({ side, contactLabel }: { side: DueByDateSide; contactLabel: string }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  const t = side.totals;

  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
            <th className="px-4 py-3">{contactLabel}</th>
            <th className={th}>Overdue now</th>
            <th className={th}>Due today to date</th>
            <th className={`${th} font-bold text-[var(--ff-text-primary)]`}>Total by date</th>
            <th className={th}>Due later</th>
            <th className={`${th} ${NO_DUE_CELL}`}>
              <span className="inline-flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" aria-hidden /> No due date</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {side.contacts.length === 0 && (
            <tr><td colSpan={6} className="px-4 py-10 text-center text-[var(--ff-text-tertiary)]">Nothing open.</td></tr>
          )}
          {side.contacts.map((c) => {
            const isOpen = open.has(c.contactId);
            return (
              <Fragment key={c.contactId}>
                <tr className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                  <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">
                    <button
                      type="button"
                      onClick={() => toggle(c.contactId)}
                      aria-expanded={isOpen}
                      aria-label={`${isOpen ? 'Hide' : 'Show'} invoices for ${c.contactName}`}
                      className="inline-flex items-center gap-1 text-left"
                    >
                      {isOpen ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronRight className="h-4 w-4" aria-hidden />}
                      {c.contactName}
                    </button>
                  </td>
                  <td className={`${num} text-red-700 dark:text-red-400`}>{formatMoney(c.overdueNow)}</td>
                  <td className={num}>{formatMoney(c.dueTodayToDate)}</td>
                  <td className={`${num} font-bold text-[var(--ff-text-primary)]`}>{formatMoney(c.totalByDate)}</td>
                  <td className={num}>{formatMoney(c.dueLater)}</td>
                  <td className={`${num} ${c.noDueDate > 0 ? NO_DUE_CELL : ''}`}>{formatMoney(c.noDueDate)}</td>
                </tr>
                {isOpen && c.invoices.map((i) => (
                  <tr key={i.id} className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-primary)]/40 text-xs">
                    <td className="pl-10 pr-4 py-2 text-[var(--ff-text-secondary)] font-id">
                      {i.invoiceNumber} <span className="font-sans text-[var(--ff-text-tertiary)]">· {formatDisplayDate(i.invoiceDate)}</span>
                    </td>
                    <td className="px-4 py-2 text-right text-[var(--ff-text-secondary)]" colSpan={2}>
                      {i.dueDate === null ? <span className="text-amber-700 dark:text-amber-400">No due date</span> : `Due ${formatDisplayDate(i.dueDate)}`}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums font-semibold text-[var(--ff-text-primary)]">
                      {formatMoney(i.counted)}
                      {i.disputed > 0 && <span className="block font-normal text-[var(--ff-text-tertiary)]">{formatMoney(i.disputed)} disputed, held out</span>}
                    </td>
                    <td className="px-4 py-2 text-right text-[var(--ff-text-secondary)]" colSpan={2}>{BUCKET_LABEL[i.bucket]}</td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-[var(--ff-border-light)] font-bold text-[var(--ff-text-primary)]">
            <td className="px-4 py-3">Total</td>
            <td className={num}>{formatMoney(t.overdueNow)}</td>
            <td className={num}>{formatMoney(t.dueTodayToDate)}</td>
            <td className={num}>{formatMoney(t.totalByDate)}</td>
            <td className={num}>{formatMoney(t.dueLater)}</td>
            <td className={`${num} ${t.noDueDate > 0 ? NO_DUE_CELL : ''}`}>{formatMoney(t.noDueDate)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
