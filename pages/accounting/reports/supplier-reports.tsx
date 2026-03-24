/**
 * Supplier Reports Page — Purchases by Supplier
 * Phase 3: Reporting Parity
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, ShoppingCart, Loader2, AlertCircle, Download } from 'lucide-react';

interface Row {
  supplierId: string;
  supplierName: string;
  invoiceCount: number;
  totalInvoiced: number;
  totalPaid: number;
  balance: number;
}

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

function getDefaultDates() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return { periodStart: start.toISOString().split('T')[0], periodEnd: now.toISOString().split('T')[0] };
}

export default function SupplierReportsPage() {
  const defaults = getDefaultDates();
  const [periodStart, setPeriodStart] = useState(defaults.periodStart);
  const [periodEnd, setPeriodEnd] = useState(defaults.periodEnd);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!periodStart || !periodEnd) return;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
      const res = await fetch(`/api/accounting/reports-supplier?${params}`, { credentials: 'include' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setRows(json.data || []);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setLoading(false); }
  }, [periodStart, periodEnd]);

  useEffect(() => { load(); }, [load]);

  function handleExport() {
    const params = new URLSearchParams();
    params.set('period_start', periodStart ?? '');
    params.set('period_end', periodEnd ?? '');
    window.location.href = `/api/accounting/supplier-report-export?${params}`;
  }

  const totals = rows.reduce((t, r) => ({
    invoiced: t.invoiced + r.totalInvoiced,
    paid: t.paid + r.totalPaid,
    balance: t.balance + r.balance,
    count: t.count + r.invoiceCount,
  }), { invoiced: 0, paid: 0, balance: 0, count: 0 });

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <Link href="/accounting/reports" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
            <ArrowLeft className="h-4 w-4" /> Back to Reports
          </Link>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-500/10"><ShoppingCart className="h-6 w-6 text-orange-500" /></div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Supplier Report</h1>
            </div>
            <button onClick={handleExport} disabled={rows.length === 0}
              className="inline-flex items-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 text-sm font-medium disabled:opacity-50">
              <Download className="h-4 w-4" /> Export CSV
            </button>
          </div>
        </div>

        <div className="p-6 max-w-5xl space-y-4">
          <div className="flex items-center gap-4">
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">From</label>
              <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} className="ff-input text-sm" />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">To</label>
              <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} className="ff-input text-sm" />
            </div>
          </div>

          {error && <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm"><AlertCircle className="h-4 w-4" /> {error}</div>}

          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-orange-500" /></div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                  <th className="px-4 py-3">Supplier</th>
                  <th className="px-4 py-3 text-right">Invoices</th>
                  <th className="px-4 py-3 text-right">Invoiced</th>
                  <th className="px-4 py-3 text-right">Paid</th>
                  <th className="px-4 py-3 text-right">Balance</th>
                </tr></thead>
                <tbody>
                  {rows.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No data for period</td></tr>}
                  {rows.map(r => (
                    <tr key={r.supplierId} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                      <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{r.supplierName}</td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)]">{r.invoiceCount}</td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-primary)] font-mono">{fmt(r.totalInvoiced)}</td>
                      <td className="px-4 py-3 text-right text-emerald-400 font-mono">{fmt(r.totalPaid)}</td>
                      <td className="px-4 py-3 text-right font-mono font-medium text-[var(--ff-text-primary)]">{fmt(r.balance)}</td>
                    </tr>
                  ))}
                  {rows.length > 0 && (
                    <tr className="bg-[var(--ff-bg-primary)] font-medium">
                      <td className="px-4 py-3 text-[var(--ff-text-primary)]">TOTAL</td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{totals.count}</td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-primary)] font-mono">{fmt(totals.invoiced)}</td>
                      <td className="px-4 py-3 text-right text-emerald-400 font-mono">{fmt(totals.paid)}</td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-primary)] font-mono">{fmt(totals.balance)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
