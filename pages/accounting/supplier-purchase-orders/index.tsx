/**
 * Supplier Purchase Orders List Page — redesigned to match ISAFlow design system
 */
import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import { ClipboardList, Plus, Search, Loader2, Trash2, ChevronRight } from 'lucide-react';
import { StatusPill, PageHeader } from '@/components/ui';
import { apiFetch } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import { formatCurrency, formatDate } from '@/utils/formatters';

interface PurchaseOrder {
  id: string;
  order_number: string;
  supplier_name: string | null;
  order_date: string;
  delivery_date: string | null;
  total_amount: number;
  status: string;
}

const TABS = ['all', 'draft', 'sent', 'received', 'invoiced'] as const;
type Tab = typeof TABS[number];

export default function SupplierPurchaseOrdersPage() {
  useCompany();
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const p = new URLSearchParams();
      if (tab !== 'all') p.set('status', tab);
      if (search) p.set('search', search);
      const res = await apiFetch(`/api/accounting/supplier-purchase-orders?${p}`);
      const json = await res.json();
      if (!res.ok) { setError(json.error?.message || json.message || 'Failed to load purchase orders'); return; }
      const d = json.data || json;
      setOrders(d.orders || []); setTotal(d.total || 0);
    } catch { setError('Failed to load purchase orders'); }
    finally { setLoading(false); }
  }, [tab, search]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: string, orderNumber: string) => {
    if (!window.confirm(`Delete draft purchase order ${orderNumber}?`)) return;
    setDeleting(id);
    try {
      const res = await apiFetch('/api/accounting/supplier-purchase-orders', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
      if (res.ok) { load(); }
      else { const json = await res.json(); setError(json.error?.message || json.message || 'Failed to delete purchase order'); }
    } catch { setError('Failed to delete purchase order'); }
    finally { setDeleting(null); }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        <PageHeader
          icon={ClipboardList}
          title="Purchase Orders"
          subtitle={`${total} ${total === 1 ? 'order' : 'orders'}`}
          actions={
            <Link href="/accounting/purchase-orders/new" className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-700 text-white rounded-lg text-sm font-medium transition-colors">
              <Plus className="w-4 h-4" /> New PO
            </Link>
          }
        />

        <div className="p-6 space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex gap-1 p-1 bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
              {TABS.map(t => (
                <button key={t} onClick={() => setTab(t)} className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize transition-colors ${tab === t ? 'bg-amber-500 text-white shadow-sm' : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>{t}</button>
              ))}
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500 dark:text-slate-400" />
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search PO #, supplier…" className="pl-9 pr-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 text-slate-900 dark:text-slate-100 transition-colors w-56" />
            </div>
          </div>

          {error && <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">{error}</div>}

          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            {loading ? (
              <div className="p-16 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-500 dark:text-slate-400" /></div>
            ) : orders.length === 0 ? (
              <div className="p-16 text-center">
                <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4"><ClipboardList className="w-7 h-7 text-slate-500 dark:text-slate-400" /></div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">No purchase orders found</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Create your first purchase order</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    {['PO #', 'Supplier', 'Date', 'Delivery Date', 'Total', 'Status', ''].map((h, i) => (
                      <th key={i} className={`px-5 py-3 text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider ${i === 4 ? 'text-right' : i === 5 ? 'text-center' : i === 6 ? 'text-right' : 'text-left'}`}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {orders.map(po => {
                    return (
                      <tr key={po.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                        <td className="px-5 py-3.5">
                          <Link href={`/accounting/supplier-purchase-orders/${po.id}`} className="font-mono text-amber-500 font-semibold hover:text-amber-400 transition-colors">{po.order_number}</Link>
                        </td>
                        <td className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{po.supplier_name || '—'}</td>
                        <td className="px-5 py-3.5 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">{formatDate(po.order_date)}</td>
                        <td className="px-5 py-3.5 text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap">{po.delivery_date ? formatDate(po.delivery_date) : '—'}</td>
                        <td className="px-5 py-3.5 text-right font-mono font-semibold text-slate-900 dark:text-white">{formatCurrency(po.total_amount)}</td>
                        <td className="px-5 py-3.5 text-center"><StatusPill status={po.status} /></td>
                        <td className="px-4 py-3.5">
                          <div className="flex justify-end items-center gap-1">
                            {po.status === 'draft' && (
                              <button onClick={() => handleDelete(po.id, po.order_number)} disabled={deleting === po.id} title="Delete draft" className="p-1.5 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20 text-slate-500 dark:text-slate-400 hover:text-red-500 transition-colors disabled:opacity-50">
                                {deleting === po.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                              </button>
                            )}
                            <Link href={`/accounting/supplier-purchase-orders/${po.id}`} className="p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 dark:text-slate-400 transition-colors">
                              <ChevronRight className="h-4 w-4" />
                            </Link>
                          </div>
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
