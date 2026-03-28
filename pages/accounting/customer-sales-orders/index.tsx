/**
 * Customer Sales Orders List Page
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { ClipboardList, Plus, Search, Loader2, Trash2, Edit } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface SalesOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  orderDate: string;
  deliveryDate: string | null;
  status: string;
  totalAmount: number;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-500/10 text-gray-400',
  confirmed: 'bg-blue-500/10 text-blue-400',
  partially_invoiced: 'bg-amber-500/10 text-amber-400',
  invoiced: 'bg-teal-500/10 text-teal-400',
  cancelled: 'bg-red-500/10 text-red-400',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  confirmed: 'Confirmed',
  partially_invoiced: 'Partially Invoiced',
  invoiced: 'Invoiced',
  cancelled: 'Cancelled',
};

const TABS = ['all', 'draft', 'confirmed', 'invoiced'] as const;

export default function CustomerSalesOrdersPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<string>('all');
  const [search, setSearch] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [form, setForm] = useState({
    customer_id: '',
    order_date: new Date().toISOString().split('T')[0],
    delivery_date: '',
    reference: '',
    notes: '',
    internal_notes: '',
  });
  const [lines, setLines] = useState([
    { description: '', quantity: 1, unit_price: 0, tax_rate: 15 },
  ]);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (tab !== 'all') params.set('status', tab);
    if (search) params.set('search', search);
    const res = await apiFetch(`/api/accounting/customer-sales-orders?${params}`);
    const json = await res.json();
    const d = json.data || json;
    setOrders(d.orders || []);
    setTotal(d.total || 0);
    setLoading(false);
  }, [tab, search]);

  useEffect(() => {
    load();
  }, [load]);

  const handleDelete = async (id: string) => {
    const confirmed = window.confirm('Delete this draft sales order?');
    if (!confirmed) return;
    setDeleting(id);
    await apiFetch('/api/accounting/customer-sales-orders', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    setDeleting(null);
    load();
  };

  const handleCreate = async () => {
    if (lines.every((l) => !l.description)) return;
    setSaving(true);
    await apiFetch('/api/accounting/customer-sales-orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        items: lines.filter((l) => l.description),
      }),
    });
    setSaving(false);
    setShowNew(false);
    setForm({
      customer_id: '',
      order_date: new Date().toISOString().split('T')[0],
      delivery_date: '',
      reference: '',
      notes: '',
      internal_notes: '',
    });
    setLines([{ description: '', quantity: 1, unit_price: 0, tax_rate: 15 }]);
    load();
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <ClipboardList className="h-6 w-6 text-blue-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                  Customer Sales Orders
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  {total} sales order{total !== 1 ? 's' : ''}
                </p>
              </div>
            </div>
            <button
              onClick={() => setShowNew(!showNew)}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm"
            >
              <Plus className="h-4 w-4" /> New Sales Order
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Tabs + Search */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex gap-1">
              {TABS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg capitalize ${
                    tab === t
                      ? 'bg-blue-600 text-white'
                      : 'text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-secondary)]'
                  }`}
                >
                  {t === 'all' ? 'All' : STATUS_LABEL[t] || t}
                </button>
              ))}
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search sales orders..."
                className="ff-input pl-9 text-sm w-64"
              />
            </div>
          </div>

          {/* New Sales Order Form */}
          {showNew && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4 space-y-3">
              <div className="grid grid-cols-3 gap-3">
                <input
                  value={form.customer_id}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, customer_id: e.target.value }))
                  }
                  placeholder="Customer ID"
                  className="ff-input text-sm"
                />
                <input
                  type="date"
                  value={form.order_date}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, order_date: e.target.value }))
                  }
                  className="ff-input text-sm"
                />
                <input
                  type="date"
                  value={form.delivery_date}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, delivery_date: e.target.value }))
                  }
                  placeholder="Delivery date"
                  className="ff-input text-sm"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <input
                  value={form.reference}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, reference: e.target.value }))
                  }
                  placeholder="Reference"
                  className="ff-input text-sm"
                />
                <input
                  value={form.notes}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, notes: e.target.value }))
                  }
                  placeholder="Notes"
                  className="ff-input text-sm"
                />
                <input
                  value={form.internal_notes}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, internal_notes: e.target.value }))
                  }
                  placeholder="Internal notes"
                  className="ff-input text-sm"
                />
              </div>
              <div className="space-y-2">
                {lines.map((l, i) => (
                  <div key={i} className="grid grid-cols-5 gap-2">
                    <input
                      value={l.description}
                      onChange={(e) => {
                        const n = [...lines];
                        n[i] = { ...l, description: e.target.value };
                        setLines(n);
                      }}
                      placeholder="Description *"
                      className="ff-input text-sm col-span-2"
                    />
                    <input
                      type="number"
                      value={l.quantity}
                      onChange={(e) => {
                        const n = [...lines];
                        n[i] = { ...l, quantity: Number(e.target.value) };
                        setLines(n);
                      }}
                      placeholder="Qty"
                      className="ff-input text-sm"
                    />
                    <input
                      type="number"
                      value={l.unit_price}
                      onChange={(e) => {
                        const n = [...lines];
                        n[i] = { ...l, unit_price: Number(e.target.value) };
                        setLines(n);
                      }}
                      placeholder="Unit price"
                      className="ff-input text-sm"
                    />
                    <div className="text-sm text-right text-[var(--ff-text-secondary)] self-center font-mono">
                      {fmt(l.quantity * l.unit_price)}
                    </div>
                  </div>
                ))}
                <button
                  onClick={() =>
                    setLines([
                      ...lines,
                      { description: '', quantity: 1, unit_price: 0, tax_rate: 15 },
                    ])
                  }
                  className="text-xs text-blue-400 hover:text-blue-300"
                >
                  + Add line
                </button>
              </div>
              <div className="flex justify-end gap-2">
                <button
                  onClick={() => setShowNew(false)}
                  className="px-3 py-1.5 text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-tertiary)] rounded-lg"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreate}
                  disabled={saving}
                  className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Create Sales Order'}
                </button>
              </div>
            </div>
          )}

          {/* Table */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {loading ? (
              <div className="p-8 text-center">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
              </div>
            ) : orders.length === 0 ? (
              <div className="p-8 text-center text-[var(--ff-text-secondary)]">
                No sales orders found
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                      Order #
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                      Customer
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                      Date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                      Delivery Date
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                      Total
                    </th>
                    <th className="px-4 py-3 text-center text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                      Status
                    </th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {orders.map((o) => (
                    <tr
                      key={o.id}
                      className="hover:bg-[var(--ff-bg-tertiary)] transition-colors"
                    >
                      <td className="px-4 py-3 text-sm font-mono text-blue-400">
                        {o.orderNumber}
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-primary)]">
                        {o.customerName}
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-secondary)]">
                        {o.orderDate?.split('T')[0]}
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-secondary)]">
                        {o.deliveryDate?.split('T')[0] || '\u2014'}
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-mono text-[var(--ff-text-primary)]">
                        {fmt(o.totalAmount)}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            STATUS_BADGE[o.status] || ''
                          }`}
                        >
                          {STATUS_LABEL[o.status] || o.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-1">
                          {o.status === 'draft' && (
                            <>
                              <button
                                onClick={() =>
                                  router.push(
                                    `/accounting/customer-sales-orders/${o.id}`
                                  )
                                }
                                title="Edit"
                                className="p-1.5 rounded hover:bg-blue-500/10 text-blue-400"
                              >
                                <Edit className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => handleDelete(o.id)}
                                disabled={deleting === o.id}
                                title="Delete"
                                className="p-1.5 rounded hover:bg-red-500/10 text-red-400 disabled:opacity-50"
                              >
                                {deleting === o.id ? (
                                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="h-3.5 w-3.5" />
                                )}
                              </button>
                            </>
                          )}
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
