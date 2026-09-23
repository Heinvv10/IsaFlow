/**
 * Expanded per-customer / per-supplier invoice list for AR and AP Aging, as at
 * the report's date. See agingPanelRows for where the rows come from.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, AlertCircle } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { buildInvoiceHref } from './invoiceReturnContext';
import { fmtDay, PANEL_TH, INVOICE_LINK } from './agingPanelFormat';
import { loadAgingPanelRows, daysOverdueAsAt, type AgingPanelRow, type AgingSide } from './agingPanelRows';

interface Props {
  side: AgingSide;
  entityId: string;
  entityName: string;
  asAtDate: string;
  colSpan: number;
}

export function AgingInvoicesPanel({ side, entityId, entityName, asAtDate, colSpan }: Props) {
  const [rows, setRows] = useState<AgingPanelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    loadAgingPanelRows(side, entityId, asAtDate)
      .then(r => { if (live) setRows(r); })
      .catch((e: unknown) => {
        if (!live) return;
        setRows([]);
        setError(e instanceof Error ? e.message : 'request failed');
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [side, entityId, asAtDate]);

  if (loading || error) return (
    <tr><td colSpan={colSpan} className="px-6 py-4 bg-[var(--ff-bg-primary)]">
      <div className={`flex items-center gap-2 text-sm ${error ? 'text-red-400' : 'text-[var(--ff-text-secondary)]'}`}>
        {error
          ? <><AlertCircle className="h-4 w-4" /> Could not load invoices for {entityName} ({error})</>
          : <><Loader2 className="h-4 w-4 animate-spin" /> Loading invoices for {entityName}...</>}
      </div>
    </td></tr>
  );

  const from = side === 'ar' ? 'ar-aging' : 'ap-aging';

  return (
    <tr>
      <td colSpan={colSpan} className="px-0 py-0 bg-[var(--ff-bg-primary)]">
        <table className="w-full">
          <thead>
            <tr className="bg-[var(--ff-bg-tertiary)]">
              <th className={`pl-12 text-left ${PANEL_TH}`}>Invoice #</th>
              <th className={`text-left ${PANEL_TH}`}>Due Date</th>
              <th className={`text-right ${PANEL_TH}`}>Total</th>
              <th className={`text-right ${PANEL_TH}`}>Paid</th>
              <th className={`text-right ${PANEL_TH}`}>Balance</th>
              <th className={`text-right ${PANEL_TH}`}>Days Overdue</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ff-border-light)]">
            {rows.length === 0 && (
              <tr><td colSpan={6} className="pl-12 pr-4 py-3 text-sm text-[var(--ff-text-secondary)]">No open invoices as at {asAtDate}.</td></tr>
            )}
            {rows.map(inv => {
              const days = daysOverdueAsAt(inv.dueDate, asAtDate);
              return (
                <tr key={inv.id} className="hover:bg-[var(--ff-bg-secondary)]">
                  <td className="pl-12 pr-4 py-2 text-sm font-mono">
                    <Link href={buildInvoiceHref(inv.id, { from, entityId, asAtDate })} className={INVOICE_LINK}>
                      {inv.invoiceNumber ?? 'View invoice'}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">
                    {fmtDay(inv.dueDate)}
                    {inv.dueDateMissing && <span className="ml-1 text-xs text-[var(--ff-text-tertiary)]">(no due date — invoice date)</span>}
                  </td>
                  <td className="px-4 py-2 text-sm text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(inv.totalAmount)}</td>
                  <td className="px-4 py-2 text-sm text-right font-mono text-teal-500">{inv.amountPaid > 0 ? formatCurrency(inv.amountPaid) : '—'}</td>
                  <td className="px-4 py-2 text-sm text-right font-mono font-bold text-[var(--ff-text-primary)]">
                    {formatCurrency(inv.balance)}
                    {(inv.disputedAmount ?? 0) > 0 && (
                      <span className="block text-xs font-normal text-amber-500">{formatCurrency(inv.disputedAmount ?? 0)} disputed</span>
                    )}
                  </td>
                  <td className={`px-4 py-2 text-sm text-right font-mono ${days > 0 ? 'text-red-400' : 'text-teal-500'}`}>
                    {days > 0 ? `${days}d` : 'Current'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </td>
    </tr>
  );
}
