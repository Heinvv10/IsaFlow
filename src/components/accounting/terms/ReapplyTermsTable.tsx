/**
 * The Re-apply terms preview (payment-terms programme PR 3, supplier bills and customer invoices alike): one row per
 * open document whose contact's terms would move its due date, old -> new, ticked when it may be overwritten. Unticked
 * rows say why.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { formatCurrencyAmount } from '@/modules/accounting/services/core/multiCurrencyService';
import { formatDisplayDate } from '@/utils/dateFormat';
import { DUE_DATE_SOURCE_LABELS } from '@/modules/accounting/services/shared/dueDateSource';
import type { ReapplyTermsConfig, TermsRow } from './reapplyTermsView.types';

interface Props {
  rows: TermsRow[];
  ticked: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (on: boolean) => void;
  config: Pick<ReapplyTermsConfig, 'party' | 'noun' | 'documentHref'>;
}

export const owingText = (r: Pick<TermsRow, 'balance' | 'currencyCode'>): string =>
  r.currencyCode ? formatCurrencyAmount(r.balance, r.currencyCode) : formatMoney(r.balance);

export function ReapplyTermsTable({ rows, ticked, onToggle, onToggleAll, config }: Props) {
  const all = rows.length > 0 && rows.every((r) => ticked.has(r.id));
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--ff-border-light)]">
      <table className="w-full text-sm" data-testid="reapply-terms-table">
        <thead className="bg-[var(--ff-bg-secondary)] text-left text-[var(--ff-text-secondary)]">
          <tr>
            <th className="px-3 py-2">
              <input type="checkbox" aria-label={`Tick every ${config.noun}`} checked={all} onChange={(e) => onToggleAll(e.target.checked)} />
            </th>
            <th className="px-3 py-2">{config.party}</th>
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
              <td className="px-3 py-2">{r.partyName}</td>
              <td className="px-3 py-2">
                <a className="text-teal-600 hover:underline" href={config.documentHref(r.id)}>{r.invoiceNumber}</a>
              </td>
              <td className="px-3 py-2">{formatDisplayDate(r.invoiceDate)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{owingText(r)}</td>
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
