/**
 * Supplier Invoices List Page
 * PRD-060 Phase 2: Accounts Payable
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { FileText, Plus, Loader2, AlertCircle, ChevronRight } from 'lucide-react';
import type { SupplierInvoice } from '@/modules/accounting/types/ap.types';
import { formatCurrency, formatDate } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

const TABS = ['all', 'draft', 'pending_approval', 'approved', 'partially_paid', 'paid', 'disputed', 'cancelled'] as const;
type Tab = typeof TABS[number];

const STATUS: Record<string, { label: string; cls: string }> = {
  draft:            { label: 'Draft',            cls: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300' },
  pending_approval: { label: 'Pending',          cls: 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' },
  approved:         { label: 'Approved',         cls: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' },
  partially_paid:   { label: 'Partial',          cls: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400' },
  paid:             { label: 'Paid',             cls: 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400' },
  disputed:         { label: 'Disputed',         cls: 'bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400' },
  cancelled:        { label: 'Cancelled',        cls: 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400' },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status];
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${s?.cls || 'bg-slate-100 dark:bg-slate-800 text-slate-500'}`}>
      {s?.label || status.replace(/_/g, ' ')}
    </span>
  );
}

export default function SupplierInvoicesPage() {
  const [invoices, setInvoices] = useState<SupplierInvoice[]>([]);
  const [total, setTotal] = useState(0);
  const [tab, setTab] = useState<Tab>('all');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const loadInvoices = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (tab !== 'all') params.set('status', tab);
      const res = await apiFetch(`/api/accounting/supplier-invoices?${params}`);
      const json = await res.json();
      const payload = json.data || json;
      setInvoices(payload.invoices || []);
      setTotal(payload.total || 0);
    } catch {
      setError('Failed to load supplier invoices');
    } finally {
      setIsLoading(false);
    }
  }, [tab]);

  useEffect(() => { void loadInvoices(); }, [loadInvoices]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-8">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10 flex items-center justify-between">
            <div>
              <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-1">Suppliers</p>
              <h1 className="text-2xl font-bold text-white">Supplier Invoices</h1>
              <p className="text-slate-400 text-sm mt-0.5">{total} {total === 1 ? 'invoice' : 'invoices'}</p>
            </div>
            <Link
              href="/accounting/supplier-invoices/new"
              className="flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-white rounded-xl text-sm font-semibold transition-colors shadow-lg shadow-amber-500/25"
            >
              <Plus className="w-4 h-4" /> New Invoice
            </Link>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Filter tabs */}
          <div className="flex gap-1 p-1 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 overflow-x-auto">
            {TABS.map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize whitespace-nowrap transition-colors ${tab === t ? 'bg-amber-500 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
              >
                {t === 'pending_approval' ? 'Pending' : t === 'partially_paid' ? 'Partial' : t}
              </button>
            ))}
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />{error}
            </div>
          )}

          {/* Table */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            {isLoading ? (
              <div className="p-16 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
              </div>
            ) : invoices.length === 0 ? (
              <div className="p-16 text-center">
                <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4">
                  <FileText className="w-7 h-7 text-slate-400" />
                </div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">No invoices found</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Record your first supplier invoice</p>
                <Link href="/accounting/supplier-invoices/new" className="inline-block mt-5 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-white text-sm font-semibold rounded-lg transition-colors">
                  New Invoice
                </Link>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Invoice #</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Supplier</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Reference</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Date</th>
                    <th className="px-5 py-3 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Total</th>
                    <th className="px-5 py-3 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Outstanding</th>
                    <th className="px-5 py-3 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Status</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {invoices.map(inv => {
                    const outstanding = inv.balance ?? (inv.totalAmount - (inv.amountPaid || 0));
                    return (
                      <tr key={inv.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                        <td className="px-5 py-3.5 font-mono text-amber-500 font-semibold">
                          <Link href={`/accounting/supplier-invoices/${inv.id}`} className="hover:underline">
                            {inv.invoiceNumber}
                          </Link>
                        </td>
                        <td className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{inv.supplierName || '—'}</td>
                        <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 max-w-[200px] truncate" title={inv.reference}>{inv.reference || '—'}</td>
                        <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs whitespace-nowrap">{formatDate(inv.invoiceDate)}</td>
                        <td className="px-5 py-3.5 text-right font-mono font-semibold text-slate-900 dark:text-white">{formatCurrency(inv.totalAmount)}</td>
                        <td className={`px-5 py-3.5 text-right font-mono font-semibold ${outstanding > 0 ? 'text-amber-500' : 'text-emerald-600 dark:text-emerald-400'}`}>
                          {formatCurrency(outstanding)}
                        </td>
                        <td className="px-5 py-3.5"><StatusBadge status={inv.status} /></td>
                        <td className="px-4 py-3.5 text-right">
                          <Link href={`/accounting/supplier-invoices/${inv.id}`} className="text-slate-400 hover:text-amber-500 transition-colors">
                            <ChevronRight className="h-4 w-4" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
