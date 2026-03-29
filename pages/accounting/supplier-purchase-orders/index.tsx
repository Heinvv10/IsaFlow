/**
 * Supplier Purchase Orders List Page
 */

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { AppLayout } from '@/components/layout/AppLayout';
import {
  ClipboardList, Plus, Search, Loader2, AlertCircle, ChevronRight, Trash2,
} from 'lucide-react';
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

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-500/20 text-gray-400',
  sent: 'bg-blue-500/20 text-blue-400',
  partially_received: 'bg-amber-500/20 text-amber-400',
  received: 'bg-teal-500/20 text-teal-400',
  partially_invoiced: 'bg-amber-500/20 text-amber-400',
  invoiced: 'bg-teal-500/20 text-teal-400',
  cancelled: 'bg-red-500/20 text-red-400',
};

const TABS = [
  { value: 'all', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'received', label: 'Received' },
  { value: 'invoiced', label: 'Invoiced' },
] as const;

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_BADGE[status] || 'bg-gray-500/20 text-gray-400'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

export default function SupplierPurchaseOrdersPage() {
  const { activeCompany } = useCompany();
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [tab, setTab] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      if (tab !== 'all') params.set('status', tab);
      if (search) params.set('search', search);
      const res = await apiFetch(`/api/accounting/supplier-purchase-orders?${params}`);
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message || json.message || 'Failed to load purchase orders');
        return;
      }
      const d = json.data || json;
      setOrders(d.orders || []);
      setTotal(d.total || 0);
    } catch {
      setError('Failed to load purchase orders');
    } finally {
      setLoading(false);
    }
  }, [tab, search]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id: string, orderNumber: string) => {
    const confirmed = window.confirm(`Delete draft purchase order ${orderNumber}?`);
    if (!confirmed) return;

    setDeleting(id);
    try {
      const res = await apiFetch('/api/accounting/supplier-purchase-orders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (res.ok) {
        load();
      } else {
        const json = await res.json();
        setError(json.error?.message || json.message || 'Failed to delete purchase order');
      }
    } catch {
      setError('Failed to delete purchase order');
    } finally {
      setDeleting(null);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/10">
                <ClipboardList className="h-6 w-6 text-indigo-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Purchase Orders</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Manage supplier purchase orders
                </p>
              </div>
            </div>
            <Link
              href="/accounting/purchase-orders/new"
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors text-sm font-medium"
            >
              <Plus className="h-4 w-4" />
              New PO
            </Link>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Tabs + Search */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex gap-1">
              {TABS.map(t => (
                <button
                  key={t.value}
                  onClick={() => setTab(t.value)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg ${
                    tab === t.value
                      ? 'bg-indigo-600 text-white'
                      : 'text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-secondary)]'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search PO #, supplier, reference..."
                className="ff-input pl-9 text-sm w-72"
              />
            </div>
          </div>

          {/* Count */}
          <p className="text-sm text-[var(--ff-text-secondary)]">
            {total} purchase order{total !== 1 ? 's' : ''}
          </p>

          {/* Error */}
          {error && (
            <div className="flex items-center gap-2 p-3 bg-red-500/10 rounded-lg text-red-400 text-sm">
              <AlertCircle className="h-4 w-4 shrink-0" />{error}
            </div>
          )}

          {/* Table */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {loading ? (
              <div className="p-8 text-center">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
              </div>
            ) : orders.length === 0 ? (
              <div className="p-8 text-center">
                <ClipboardList className="h-8 w-8 text-[var(--ff-text-tertiary)] mx-auto mb-2" />
                <p className="text-[var(--ff-text-secondary)]">No purchase orders found</p>
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">PO #</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Supplier</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Date</th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Delivery Date</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Total</th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Status</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {orders.map(po => (
                    <tr key={po.id} className="hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                      <td className="px-4 py-3 text-sm font-mono text-indigo-400">
                        <Link
                          href={`/accounting/supplier-purchase-orders/${po.id}`}
                          className="hover:text-indigo-300 transition-colors"
                        >
                          {po.order_number}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-primary)]">
                        {po.supplier_name || '-'}
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-secondary)] whitespace-nowrap">
                        {formatDate(po.order_date)}
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-secondary)] whitespace-nowrap">
                        {po.delivery_date ? formatDate(po.delivery_date) : '-'}
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-mono text-[var(--ff-text-primary)]">
                        {formatCurrency(po.total_amount)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <StatusBadge status={po.status} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-1">
                          {po.status === 'draft' && (
                            <button
                              onClick={() => handleDelete(po.id, po.order_number)}
                              disabled={deleting === po.id}
                              title="Delete draft"
                              className="p-1.5 rounded hover:bg-red-500/10 text-red-400 disabled:opacity-50"
                            >
                              {deleting === po.id
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <Trash2 className="h-3.5 w-3.5" />
                              }
                            </button>
                          )}
                          <Link
                            href={`/accounting/supplier-purchase-orders/${po.id}`}
                            className="p-1.5 rounded hover:bg-indigo-500/10 text-indigo-400"
                            title="View"
                          >
                            <ChevronRight className="h-4 w-4" />
                          </Link>
                        </div>
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
