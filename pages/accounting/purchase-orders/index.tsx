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

interface PO { id: string; po_number: string; supplier_name: string; order_date: string; expected_delivery_date: string; status: string; subtotal: number; tax_amount: number; total: number; }
const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);
const statusColors: Record<string, string> = { draft: 'bg-gray-500/10 text-gray-400', submitted: 'bg-blue-500/10 text-blue-400', approved: 'bg-teal-500/10 text-teal-400', partially_received: 'bg-amber-500/10 text-amber-400', received: 'bg-green-500/10 text-green-400', cancelled: 'bg-red-500/10 text-red-400' };

export default function PurchaseOrdersPage() {
  const [orders, setOrders] = useState<PO[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  const load = useCallback(async () => {
    const params = statusFilter ? `?status=${statusFilter}` : '';
    try {
      const res = await apiFetch(`/api/accounting/purchase-orders${params}`, { credentials: 'include' });
      const json = await res.json();
      setOrders(json.data || []);
    } catch { setOrders([]); }
    setLoading(false);
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  const totalValue = orders.reduce((s, o) => s + Number(o.total || 0), 0);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-500/10"><ShoppingCart className="h-6 w-6 text-orange-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Purchase Orders</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Manage purchase orders and track deliveries</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ExportCSVButton endpoint="/api/accounting/purchase-orders?format=csv" filenamePrefix="purchase-orders" label="Export" />
              <Link href="/accounting/purchase-orders/new" className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium">
                <Plus className="h-4 w-4" /> New PO
              </Link>
            </div>
          </div>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Total Orders</p>
              <p className="text-xl font-bold text-[var(--ff-text-primary)]">{orders.length}</p>
            </div>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Total Value</p>
              <p className="text-xl font-bold text-teal-400">{fmt(totalValue)}</p>
            </div>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Pending Delivery</p>
              <p className="text-xl font-bold text-amber-400">{orders.filter(o => ['approved', 'partially_received'].includes(o.status)).length}</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="ff-select text-sm">
              <option value="">All Status</option>
              <option value="draft">Draft</option>
              <option value="submitted">Submitted</option>
              <option value="approved">Approved</option>
              <option value="partially_received">Partially Received</option>
              <option value="received">Received</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-3">PO #</th><th className="px-4 py-3">Supplier</th><th className="px-4 py-3">Order Date</th>
                <th className="px-4 py-3">Delivery Date</th><th className="px-4 py-3 text-right">Total</th><th className="px-4 py-3">Status</th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]"><Loader2 className="h-5 w-5 animate-spin inline mr-2" />Loading...</td></tr>}
                {!loading && orders.length === 0 && <tr><td colSpan={6} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No purchase orders. <Link href="/accounting/purchase-orders/new" className="text-teal-400 hover:underline">Create one</Link></td></tr>}
                {orders.map(o => (
                  <tr key={o.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 font-medium text-[var(--ff-text-primary)]"><Link href={`/accounting/purchase-orders/${o.id}`} className="hover:text-teal-400">{o.po_number}</Link></td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{o.supplier_name}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{o.order_date}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{o.expected_delivery_date || '-'}</td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(Number(o.total))}</td>
                    <td className="px-4 py-3"><span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${statusColors[o.status] || ''}`}>{(o.status || '').replace(/_/g, ' ')}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
