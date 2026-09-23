/**
 * Expanded per-supplier invoice list for AP Aging. Reads the existing supplier
 * invoice list (balance > 0) and keeps the statuses the aging counts, so every
 * invoice number drills through to the invoice with a return context.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import type { SupplierInvoice } from '@/modules/accounting/types/ap.types';
import { documentInPopulation } from '@/modules/accounting/services/shared/documentPopulation';
import { buildInvoiceHref } from './invoiceReturnContext';
import { fmtZar, fmtDay, PANEL_TH, INVOICE_LINK } from './agingPanelFormat';

const LIMIT = 200;

interface Props {
  supplierId: string;
  supplierName: string;
  colSpan: number;
  asAtDate?: string;
  note?: string;
}

export function SupplierInvoicesPanel({ supplierId, supplierName, colSpan, asAtDate, note }: Props) {
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams({
      supplier_id: supplierId, from_balance: '0.01', sort: 'invoice_date', sort_order: 'asc', limit: String(LIMIT),
    });
    apiFetch(`/api/accounting/supplier-invoices?${params}`)
      .then(async r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const json = await r.json() as { data?: { invoices?: unknown; total?: unknown } };
        const rows = Array.isArray(json.data?.invoices) ? json.data.invoices as SupplierInvoice[] : [];
        setInvoices(rows.filter(inv => documentInPopulation(inv.status)));
        setTotal(typeof json.data?.total === 'number' ? json.data.total : rows.length);
      })
      .catch((e: unknown) => {
        setInvoices([]);
        setError(e instanceof Error ? e.message : 'request failed');
      })
      .finally(() => setLoading(false));
  }, [supplierId]);

  if (loading || error) return (
    <tr><td colSpan={colSpan} className="px-6 py-4 bg-[var(--ff-bg-primary)]">
      <div className={`flex items-center gap-2 text-sm ${error ? 'text-red-400' : 'text-[var(--ff-text-secondary)]'}`}>
        {error
          ? <><AlertCircle className="h-4 w-4" /> Could not load invoices for {supplierName} ({error})</>
          : <><Loader2 className="h-4 w-4 animate-spin" /> Loading invoices for {supplierName}...</>}
      </div>
    </td></tr>
  );

  return (
    <tr>
      <td colSpan={colSpan} className="px-0 py-0 bg-[var(--ff-bg-primary)]">
        {note && <p className="pl-12 pr-4 py-2 text-xs text-[var(--ff-text-tertiary)]">{note}</p>}
        {total > LIMIT && (
          <p className="pl-12 pr-4 py-2 text-xs text-amber-500">
            Showing the oldest {LIMIT} of {total} open invoices — see the supplier statement for the rest.
          </p>
        )}
        <table className="w-full">
          <thead>
            <tr className="bg-[var(--ff-bg-tertiary)]">
              <th className={`pl-12 text-left ${PANEL_TH}`}>Invoice #</th>
              <th className={`text-left ${PANEL_TH}`}>Invoice Date</th>
              <th className={`text-left ${PANEL_TH}`}>Due Date</th>
              <th className={`text-right ${PANEL_TH}`}>Total</th>
              <th className={`text-right ${PANEL_TH}`}>Paid</th>
              <th className={`text-right ${PANEL_TH}`}>Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--ff-border-light)]">
            {invoices.length === 0 && (
              <tr><td colSpan={6} className="pl-12 pr-4 py-3 text-sm text-[var(--ff-text-secondary)]">No open invoices today.</td></tr>
            )}
            {invoices.map(inv => (
              <tr key={inv.id} className="hover:bg-[var(--ff-bg-secondary)]">
                <td className="pl-12 pr-4 py-2 text-sm font-mono">
                  <Link href={buildInvoiceHref(inv.id, { from: 'ap-aging', entityId: supplierId, asAtDate })} className={INVOICE_LINK}>
                    {inv.invoiceNumber}
                  </Link>
                </td>
                <td className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">{fmtDay(inv.invoiceDate)}</td>
                <td className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">{fmtDay(inv.dueDate)}</td>
                <td className="px-4 py-2 text-sm text-right font-mono text-[var(--ff-text-primary)]">{fmtZar(Number(inv.totalAmount))}</td>
                <td className="px-4 py-2 text-sm text-right font-mono text-teal-500">{Number(inv.amountPaid) > 0 ? fmtZar(Number(inv.amountPaid)) : '—'}</td>
                <td className="px-4 py-2 text-sm text-right font-mono font-bold text-[var(--ff-text-primary)]">{fmtZar(Number(inv.balance))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </td>
    </tr>
  );
}
