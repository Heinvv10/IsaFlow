/**
 * Debtors Manager's expanded per-customer invoice list. Each invoice number
 * drills through to the invoice with a return context.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import type { DebtorInvoice } from '@/modules/accounting/services/ar/debtorsManagerService';
import { buildInvoiceHref } from './invoiceReturnContext';
import { fmtDay, PANEL_TH, INVOICE_LINK } from './agingPanelFormat';

const BUCKET_COLORS = {
  current: 'text-teal-500',
  days30: 'text-amber-500',
  days60: 'text-orange-500',
  days90: 'text-red-400',
  days90Plus: 'text-red-600',
};

const COL_SPAN = 8;

export function DebtorInvoicesPanel({ clientId, clientName }: { clientId: string; clientName: string }) {
  const [invoices, setInvoices] = useState<DebtorInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    apiFetch(`/api/accounting/debtors-manager?customerId=${encodeURIComponent(clientId)}`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = await r.json() as { data?: unknown };
        setInvoices(Array.isArray(json.data) ? json.data as DebtorInvoice[] : []);
      })
      .catch((e: unknown) => {
        setInvoices([]);
        setError(e instanceof Error ? e.message : 'request failed');
      })
      .finally(() => setLoading(false));
  }, [clientId]);

  if (loading || error) return (
    <tr><td colSpan={COL_SPAN} className="px-6 py-4 bg-[var(--ff-bg-primary)]">
      <div className={`flex items-center gap-2 text-sm ${error ? 'text-red-400' : 'text-[var(--ff-text-secondary)]'}`}>
        {error
          ? <><AlertCircle className="h-4 w-4" /> Could not load invoices for {clientName} ({error})</>
          : <><Loader2 className="h-4 w-4 animate-spin" /> Loading invoices for {clientName}...</>}
      </div>
    </td></tr>
  );

  return (
    <tr>
      <td colSpan={COL_SPAN} className="px-0 py-0 bg-[var(--ff-bg-primary)]">
        <table className="w-full">
          <thead>
            <tr className="bg-[var(--ff-bg-tertiary)]">
              <th className={`pl-12 text-left ${PANEL_TH}`}>Invoice #</th>
              <th className={`text-left ${PANEL_TH}`}>Invoice Date</th>
              <th className={`text-left ${PANEL_TH}`}>Due Date</th>
              <th className={`text-right ${PANEL_TH}`}>Total</th>
              <th className={`text-right ${PANEL_TH}`}>Paid</th>
              <th className={`text-right ${PANEL_TH}`}>Outstanding</th>
              <th className={`text-right ${PANEL_TH}`}>Days Overdue</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ff-border-light)]">
            {invoices.map(inv => (
              <tr key={inv.id} className="hover:bg-[var(--ff-bg-secondary)]">
                <td className="pl-12 pr-4 py-2 text-sm font-mono">
                  <Link href={buildInvoiceHref(inv.id, { from: 'debtors', entityId: clientId })} className={INVOICE_LINK}>
                    {inv.invoiceNumber}
                  </Link>
                </td>
                <td className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">{fmtDay(inv.invoiceDate)}</td>
                <td className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">{fmtDay(inv.dueDate)}</td>
                <td className="px-4 py-2 text-sm text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(inv.totalAmount)}</td>
                <td className="px-4 py-2 text-sm text-right font-mono text-teal-500">{inv.amountPaid > 0 ? formatCurrency(inv.amountPaid) : '—'}</td>
                <td className={`px-4 py-2 text-sm text-right font-mono font-bold ${BUCKET_COLORS[inv.agingBucket]}`}>{formatCurrency(inv.outstanding)}</td>
                <td className={`px-4 py-2 text-sm text-right font-mono ${inv.daysOverdue > 0 ? 'text-red-400' : 'text-teal-500'}`}>
                  {inv.daysOverdue > 0 ? `${inv.daysOverdue}d` : 'Current'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </td>
    </tr>
  );
}
