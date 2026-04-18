/**
 * Sales Order Detail Page — view, confirm, convert to invoice
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { ClipboardList, ArrowLeft, CheckCircle, FileText, Loader2, AlertCircle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { formatDate } from '@/utils/formatters';

interface SalesOrderItem {
  id: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate: number;
  lineTotal: number;
}

interface SalesOrder {
  id: string;
  orderNumber: string;
  customerName: string;
  customerId: string | null;
  orderDate: string;
  deliveryDate: string | null;
  reference: string | null;
  status: string;
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  notes: string | null;
  items?: SalesOrderItem[];
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const STATUS_BADGE: Record<string, string> = {
  draft: 'bg-gray-500/10 text-gray-400',
  confirmed: 'bg-blue-500/10 text-blue-400',
  invoiced: 'bg-teal-500/10 text-teal-400',
  partially_invoiced: 'bg-amber-500/10 text-amber-400',
  cancelled: 'bg-red-500/10 text-red-400',
};

const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  confirmed: 'Confirmed',
  invoiced: 'Invoiced',
  partially_invoiced: 'Partially Invoiced',
  cancelled: 'Cancelled',
};

export default function SalesOrderDetailPage() {
  const router = useRouter();
  const { id } = router.query;
  const [order, setOrder] = useState<SalesOrder | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  useEffect(() => {
    if (!id || typeof id !== 'string') return;
    setLoading(true);
    setError('');
    apiFetch(`/api/accounting/customer-sales-orders?id=${id}`)
      .then((r) => r.json())
      .then((json) => {
        const d = json.data || json;
        setOrder(d);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : 'Failed to load order')
      )
      .finally(() => setLoading(false));
  }, [id]);

  const handleAction = async (action: 'confirm' | 'invoice') => {
    if (!order) return;
    setActionBusy(true);
    setSuccessMsg('');
    setError('');
    try {
      const res = await apiFetch('/api/accounting/customer-sales-orders-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: order.id, action }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error?.message || `Action '${action}' failed`);
        return;
      }
      if (action === 'invoice') {
        const invoiceId = json.data?.invoiceId || json.invoiceId;
        await router.push(`/accounting/customer-invoices/${invoiceId}`);
        return;
      }
      setSuccessMsg(action === 'confirm' ? 'Order confirmed successfully.' : 'Done.');
      // Reload the order
      const refreshRes = await apiFetch(`/api/accounting/customer-sales-orders?id=${order.id}`);
      const refreshJson = await refreshRes.json();
      setOrder(refreshJson.data || refreshJson);
    } finally {
      setActionBusy(false);
    }
  };

  if (loading) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-[var(--ff-text-tertiary)]" />
        </div>
      </AppLayout>
    );
  }

  if (!order) {
    return (
      <AppLayout>
        <div className="min-h-screen bg-[var(--ff-bg-primary)] flex items-center justify-center">
          <div className="text-center text-[var(--ff-text-secondary)]">
            <AlertCircle className="h-8 w-8 mx-auto mb-2 text-red-400" />
            {error || 'Sales order not found'}
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => router.push('/accounting/customer-sales-orders')}
                className="p-1.5 rounded hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)]"
                title="Back to Orders"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
              <div className="p-2 rounded-lg bg-blue-500/10">
                <ClipboardList className="h-6 w-6 text-blue-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                  {order.orderNumber}
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  {order.customerName || 'No customer'} &middot; {formatDate(order.orderDate)}
                </p>
              </div>
              <span
                className={`ml-2 px-2.5 py-0.5 rounded-full text-xs font-medium ${
                  STATUS_BADGE[order.status] || ''
                }`}
              >
                {STATUS_LABEL[order.status] || order.status}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {order.status === 'draft' && (
                <button
                  onClick={() => handleAction('confirm')}
                  disabled={actionBusy}
                  className="flex items-center gap-1.5 px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-lg text-sm disabled:opacity-50"
                >
                  {actionBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle className="h-4 w-4" />
                  )}
                  Confirm Order
                </button>
              )}
              {order.status === 'confirmed' && (
                <button
                  onClick={() => handleAction('invoice')}
                  disabled={actionBusy}
                  className="flex items-center gap-1.5 px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-lg text-sm disabled:opacity-50"
                >
                  {actionBusy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <FileText className="h-4 w-4" />
                  )}
                  Create Invoice
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4 max-w-5xl">
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg px-4 py-3 text-sm">
              {error}
            </div>
          )}
          {successMsg && (
            <div className="bg-teal-500/10 border border-teal-500/20 text-teal-400 rounded-lg px-4 py-3 text-sm">
              {successMsg}
            </div>
          )}

          {/* Order Details */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-[var(--ff-text-tertiary)] text-xs uppercase mb-1">Customer</p>
                <p className="text-[var(--ff-text-primary)] font-medium">
                  {order.customerName || '—'}
                </p>
              </div>
              <div>
                <p className="text-[var(--ff-text-tertiary)] text-xs uppercase mb-1">Order Date</p>
                <p className="text-[var(--ff-text-primary)]">{formatDate(order.orderDate)}</p>
              </div>
              <div>
                <p className="text-[var(--ff-text-tertiary)] text-xs uppercase mb-1">Delivery Date</p>
                <p className="text-[var(--ff-text-primary)]">
                  {order.deliveryDate ? formatDate(order.deliveryDate) : '—'}
                </p>
              </div>
              <div>
                <p className="text-[var(--ff-text-tertiary)] text-xs uppercase mb-1">Reference</p>
                <p className="text-[var(--ff-text-primary)]">{order.reference || '—'}</p>
              </div>
            </div>
            {order.notes && (
              <div className="mt-3 pt-3 border-t border-[var(--ff-border-light)]">
                <p className="text-[var(--ff-text-tertiary)] text-xs uppercase mb-1">Notes</p>
                <p className="text-[var(--ff-text-secondary)] text-sm">{order.notes}</p>
              </div>
            )}
          </div>

          {/* Line Items */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                    Description
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                    Qty
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                    Unit Price
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                    VAT %
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                    Line Total
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--ff-border-light)]">
                {(order.items || []).length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-6 text-center text-[var(--ff-text-secondary)] text-sm">
                      No line items
                    </td>
                  </tr>
                ) : (
                  order.items!.map((item) => (
                    <tr key={item.id} className="hover:bg-[var(--ff-bg-tertiary)]">
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-primary)]">
                        {item.description}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-[var(--ff-text-secondary)] font-mono">
                        {item.quantity}
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-mono text-[var(--ff-text-primary)]">
                        {fmt(item.unitPrice)}
                      </td>
                      <td className="px-4 py-3 text-sm text-right text-[var(--ff-text-secondary)]">
                        {item.taxRate}%
                      </td>
                      <td className="px-4 py-3 text-sm text-right font-mono text-[var(--ff-text-primary)]">
                        {fmt(item.lineTotal)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>

            {/* Totals */}
            <div className="border-t border-[var(--ff-border-light)] p-4">
              <div className="flex flex-col items-end gap-1 text-sm">
                <div className="flex justify-between w-48">
                  <span className="text-[var(--ff-text-secondary)]">Subtotal</span>
                  <span className="font-mono text-[var(--ff-text-primary)]">{fmt(order.subtotal)}</span>
                </div>
                <div className="flex justify-between w-48">
                  <span className="text-[var(--ff-text-secondary)]">VAT</span>
                  <span className="font-mono text-[var(--ff-text-primary)]">{fmt(order.taxAmount)}</span>
                </div>
                <div className="flex justify-between w-48 pt-1 border-t border-[var(--ff-border-light)] font-semibold">
                  <span className="text-[var(--ff-text-primary)]">Total</span>
                  <span className="font-mono text-[var(--ff-text-primary)]">{fmt(order.totalAmount)}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
