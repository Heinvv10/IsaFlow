/**
 * Purchase Orders List Page
 * Route: /accounting/purchase-orders
 */
import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ShoppingCart, Loader2, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { apiFetch } from '@/lib/apiFetch';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';

interface PO {
  id: string; po_number: string; supplier_name: string;
  order_date: string; expected_delivery_date: string;
  status: string; subtotal: number; tax_amount: number; total: number;
}

const fmt = (n: number) => `R ${new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`;

const STATUS: Record<string, string> = {
  draft:              'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300',
  submitted:          'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400',
  approved:           'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400',
  partially_received: 'bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400',
  received:           'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400',
  cancelled:          'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400',
};

const TABS = ['all', 'draft', 'submitted', 'approved', 'partially_received', 'received', 'cancelled'] as const;

export default function PurchaseOrdersPage() {
  const [orders, setOrders] = useState<PO[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('all');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (tab !== 'all') params.set('status', tab);
    if (search) params.set('search', search);
    const res = await apiFetch(`/api/accounting/purchase-orders?${params}`, { credentials: 'include' });
    const json = await res.json();
    setOrders(json.data || []);
    setLoading(false);
  }, [tab, search]);

  useEffect(() => { void load(); }, [load]);

  const count = orders.length;
  const pendingCount = orders.filter(o => ['approved', 'partially_received'].includes(o.status)).length;

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        {/* Hero header */}
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-8">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10 flex items-center justify-between">
            <div>
              <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-1">Purchasing</p>
              <h1 className="text-2xl font-bold text-white">Purchase Orders</h1>
              <p className="text-slate-400 text-sm mt-0.5">{count} {count === 1 ? 'order' : 'orders'}{pendingCount > 0 ? ` · ${pendingCount} pending delivery` : ''}</p>
            </div>
            <div className="flex items-center gap-2">
              <ExportCSVButton endpoint="/api/accounting/purchase-orders?format=csv" filenamePrefix="purchase-orders" label="Export" />
              <Link href="/accounting/purchase-orders/new" className="flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-white rounded-xl text-sm font-semibold transition-colors shadow-lg shadow-amber-500/25">
                <Plus className="w-4 h-4" /> New PO
              </Link>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Filters */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex gap-1 p-1 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 flex-wrap">
              {TABS.map(t => (
                <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${tab === t ? 'bg-amber-500 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
                  {t.replace(/_/g, ' ')}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search PO #, supplier…" className="pl-9 pr-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 text-slate-900 dark:text-slate-100 transition-colors w-56" />
            </div>
          </div>

          {/* Table */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            {loading ? (
              <div className="p-16 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
            ) : orders.length === 0 ? (
              <div className="p-16 text-center">
                <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4">
                  <ShoppingCart className="w-7 h-7 text-slate-400" />
                </div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">No orders found</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Create your first purchase order</p>
                <Link href="/accounting/purchase-orders/new" className="mt-5 inline-block px-4 py-2 bg-amber-500 hover:bg-amber-400 text-white text-sm font-semibold rounded-lg transition-colors">New PO</Link>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    {['PO #', 'Supplier', 'Order Date', 'Delivery Date', 'Total', 'Status'].map((h, i) => (
                      <th key={i} className={`px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider ${i === 4 ? 'text-right' : 'text-left'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {orders.map(o => (
                    <tr key={o.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                      <td className="px-5 py-3.5 font-mono text-amber-500 font-semibold">
                        <Link href={`/accounting/purchase-orders/${o.id}`} className="hover:text-amber-400 transition-colors">{o.po_number}</Link>
                      </td>
                      <td className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{o.supplier_name}</td>
                      <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{o.order_date?.split('T')[0]}</td>
                      <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{o.expected_delivery_date?.split('T')[0] || '—'}</td>
                      <td className="px-5 py-3.5 text-right font-mono font-semibold text-slate-900 dark:text-white">{fmt(Number(o.total))}</td>
                      <td className="px-5 py-3.5">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS[o.status] || 'bg-slate-100 dark:bg-slate-800 text-slate-500'}`}>
                          {(o.status || '').replace(/_/g, ' ')}
                        </span>
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
