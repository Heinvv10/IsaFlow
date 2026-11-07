/**
 * The Re-apply terms preview (payment-terms programme PR 3): one row per open bill whose supplier's terms would move its
 * due date, old -> new, ticked when it may be overwritten. Unticked rows say why.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayDate } from '@/utils/dateFormat';
import { DUE_DATE_SOURCE_LABELS } from '@/modules/accounting/services/shared/dueDateSource';
import type { ReapplyRow } from '@/modules/accounting/services/ap/reapplyTerms';

interface Props {
  rows: ReapplyRow[];
  ticked: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (on: boolean) => void;
}

export function ReapplyTermsTable({ rows, ticked, onToggle, onToggleAll }: Props) {
  const all = rows.length > 0 && rows.every((r) => ticked.has(r.id));
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--ff-border-light)]">
      <table className="w-full text-sm" data-testid="reapply-terms-table">
        <thead className="bg-[var(--ff-bg-secondary)] text-left text-[var(--ff-text-secondary)]">
          <tr>
            <th className="px-3 py-2">
              <input type="checkbox" aria-label="Tick every bill" checked={all} onChange={(e) => onToggleAll(e.target.checked)} />
            </th>
            <th className="px-3 py-2">Supplier</th>
            <th className="px-3 py-2">Invoice</th>
            <th className="px-3 py-2">Invoice date</th>
            <th className="px-3 py-2 text-right">Owing</th>
            <th className="px-3 py-2">Terms</th>
            <th className="px-3 py-2">Due date now</th>
            <th className="px-3 py-2">New due date</th>
            <th className="px-3 py-2">Note</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-[var(--ff-border-light)] text-[var(--ff-text-primary)]">
              <td className="px-3 py-2">
                <input type="checkbox" aria-label={`Re-date ${r.invoiceNumber}`} checked={ticked.has(r.id)} onChange={() => onToggle(r.id)} />
              </td>
              <td className="px-3 py-2">{r.supplierName}</td>
              <td className="px-3 py-2">
                <a className="text-teal-600 hover:underline" href={`/accounting/supplier-invoices/${r.id}`}>{r.invoiceNumber}</a>
              </td>
              <td className="px-3 py-2">{formatDisplayDate(r.invoiceDate)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatMoney(r.balance)}</td>
              <td className="px-3 py-2">{r.terms}</td>
              <td className="px-3 py-2">
                {r.currentDueDate ? formatDisplayDate(r.currentDueDate) : 'None'}
                <span className="block text-xs text-[var(--ff-text-secondary)]">{DUE_DATE_SOURCE_LABELS[r.currentSource]}</span>
              </td>
              <td className="px-3 py-2 font-medium">{formatDisplayDate(r.newDueDate)}</td>
              <td className="px-3 py-2 text-xs text-amber-600 dark:text-amber-400">{r.note ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
