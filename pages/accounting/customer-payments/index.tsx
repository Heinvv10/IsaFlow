/**
 * Customer Payments List Page — redesigned with elevated design system
 */
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { CreditCard, Plus, Loader2, Search } from 'lucide-react';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';
import { StatusPill, PageHeader } from '@/components/ui';
import type { CustomerPayment } from '@/modules/accounting/types/ar.types';
import { apiFetch } from '@/lib/apiFetch';

const TABS = ['all', 'draft', 'confirmed', 'reconciled', 'cancelled'] as const;

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export default function CustomerPaymentsPage() {
  const router = useRouter();
  const [payments, setPayments] = useState<CustomerPayment[]>([]);
  const [total, setTotal] = useState(0);
  const [tab, setTab] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams();
      if (tab !== 'all') params.set('status', tab);
      if (search) params.set('search', search);
      const res = await apiFetch(`/api/accounting/customer-payments?${params}`);
      const json = await res.json() as { data?: { payments?: CustomerPayment[]; total?: number }; payments?: CustomerPayment[]; total?: number };
      const payload = json.data || json;
      setPayments((payload as { payments?: CustomerPayment[] }).payments || []);
      setTotal((payload as { total?: number }).total || 0);
    } catch {
      setError('Failed to load customer payments');
    } finally { setLoading(false); }
  }, [tab, search]);

  useEffect(() => { void load(); }, [load]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <PageHeader
          icon={CreditCard}
          title="Customer Receipts"
          subtitle={`${total} ${total === 1 ? 'payment' : 'payments'}`}
          actions={
            <>
              <ExportCSVButton endpoint="/api/accounting/customer-payments-export" filenamePrefix="customer-payments" params={{ status: tab !== 'all' ? tab : '' }} label="Export" />
              <button onClick={() => router.push('/accounting/customer-payments/new')} className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors">
                <Plus className="w-4 h-4" /> Record Payment
              </button>
            </>
          }
        />

        <div className="p-6 space-y-4">
          {error && <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 px-4 py-3 rounded-xl text-sm">{error}</div>}

          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex gap-1 p-1 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
              {TABS.map(t => (
                <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${tab === t ? 'bg-amber-500 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
                  {t === 'all' ? 'All' : t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500 dark:text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search payments…" className="pl-9 pr-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 text-slate-900 dark:text-slate-100 transition-colors w-56" />
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            {loading ? (
              <div className="p-16 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-500 dark:text-slate-400" /></div>
            ) : payments.length === 0 ? (
              <div className="p-16 text-center">
                <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4"><CreditCard className="w-7 h-7 text-slate-500 dark:text-slate-400" /></div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">No payments found</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Record your first customer payment</p>
                <button onClick={() => router.push('/accounting/customer-payments/new')} className="mt-5 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white text-sm font-semibold rounded-lg transition-colors">Record Payment</button>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    {['Payment #', 'Client', 'Date', 'Amount', 'Method', 'Status'].map((h, i) => (
                      <th key={i} className={`px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider ${i === 3 ? 'text-right' : 'text-left'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {payments.map(p => (
                      <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors cursor-pointer" onClick={() => router.push(`/accounting/customer-payments/${p.id}`)}>
                        <td className="px-5 py-3.5 font-mono text-amber-500 font-semibold">{p.paymentNumber}</td>
                        <td className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{p.clientName || '—'}</td>
                        <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{new Date(p.paymentDate).toLocaleDateString('en-ZA')}</td>
                        <td className="px-5 py-3.5 text-right font-mono font-semibold text-slate-900 dark:text-white">{fmt(Number(p.totalAmount))}</td>
                        <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 uppercase text-xs">{p.paymentMethod}</td>
                        <td className="px-5 py-3.5">
                          <StatusPill status={p.status} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
