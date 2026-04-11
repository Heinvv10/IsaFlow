/**
 * New Delivery Note Page
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { Truck, Loader2, ArrowLeft } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import {
  DeliveryNoteLineEditor,
  emptyLine,
  type LineItem,
} from '@/components/accounting/deliveryNotes/DeliveryNoteLineEditor';

interface CustomerOption {
  id: string;
  name?: string;
  company_name?: string;
  companyName?: string;
}

interface SalesOrderOption {
  id: string;
  orderNumber: string;
}

export default function NewDeliveryNotePage() {
  const router = useRouter();

  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [salesOrders, setSalesOrders] = useState<SalesOrderOption[]>([]);
  const [loadingCustomers, setLoadingCustomers] = useState(true);
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const [customerId, setCustomerId] = useState('');
  const [salesOrderId, setSalesOrderId] = useState('');
  const [deliveryDate, setDeliveryDate] = useState(new Date().toISOString().split('T')[0]!);
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineItem[]>([emptyLine()]);

  const { sales_order_id, customer_id } = router.query;

  useEffect(() => {
    setLoadingCustomers(true);
    apiFetch('/api/accounting/customers')
      .then((r) => r.json())
      .then((json: { data?: CustomerOption[] } | CustomerOption[]) => {
        const list: CustomerOption[] = Array.isArray(json)
          ? json
          : Array.isArray((json as { data?: CustomerOption[] }).data)
            ? ((json as { data: CustomerOption[] }).data)
            : [];
        setCustomers(
          list.map((c) => ({
            id: String(c.id),
            name: String(c.name ?? c.company_name ?? c.companyName ?? ''),
          })),
        );
      })
      .catch(() => setError('Failed to load customers'))
      .finally(() => setLoadingCustomers(false));
  }, []);

  useEffect(() => {
    if (typeof customer_id === 'string' && customer_id) setCustomerId(customer_id);
    if (typeof sales_order_id === 'string' && sales_order_id) setSalesOrderId(sales_order_id);
  }, [customer_id, sales_order_id]);

  useEffect(() => {
    if (!customerId) {
      setSalesOrders([]);
      setSalesOrderId('');
      return;
    }
    setLoadingOrders(true);
    apiFetch('/api/accounting/customer-sales-orders?status=confirmed')
      .then((r) => r.json())
      .then((json: { data?: { orders?: SalesOrderOption[] } }) => {
        setSalesOrders(json?.data?.orders ?? []);
      })
      .catch(() => setSalesOrders([]))
      .finally(() => setLoadingOrders(false));
  }, [customerId]);

  const handleSave = async (dispatchAfter: boolean) => {
    setError('');
    if (!customerId) { setError('Please select a customer'); return; }
    const validLines = lines.filter((l) => l.description.trim());
    if (validLines.length === 0) {
      setError('At least one line item with a description is required');
      return;
    }

    setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/delivery-notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_id: customerId,
          sales_order_id: salesOrderId || undefined,
          delivery_date: deliveryDate,
          delivery_address: deliveryAddress || undefined,
          notes: notes || undefined,
          lines: validLines,
        }),
      });
      const json = (await res.json()) as {
        data?: { id?: string };
        error?: { message?: string };
      };
      if (!res.ok) {
        setError(json?.error?.message ?? 'Failed to create delivery note');
        return;
      }
      const noteId = json?.data?.id ?? '';
      if (dispatchAfter && noteId) {
        await apiFetch('/api/accounting/delivery-notes', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: noteId, status: 'dispatched' }),
        });
      }
      await router.push('/accounting/delivery-notes');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save delivery note');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/accounting/delivery-notes')}
              className="p-1.5 rounded hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)]"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="p-2 rounded-lg bg-teal-500/10">
              <Truck className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Delivery Note</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Create a new delivery note</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-3xl space-y-6">
          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded text-sm">
              {error}
            </div>
          )}

          {/* Details card */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] uppercase tracking-wide">
              Delivery Details
            </h2>
            <div className="grid grid-cols-2 gap-4">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--ff-text-secondary)]">Customer *</label>
                {loadingCustomers ? (
                  <div className="ff-input flex items-center gap-2 text-sm text-[var(--ff-text-tertiary)]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading...
                  </div>
                ) : (
                  <select
                    value={customerId}
                    onChange={(e) => { setCustomerId(e.target.value); setSalesOrderId(''); }}
                    className="ff-input text-sm"
                  >
                    <option value="">Select customer...</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {String(c.name ?? c.company_name ?? c.companyName ?? '')}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--ff-text-secondary)]">Delivery Date *</label>
                <input
                  type="date"
                  value={deliveryDate}
                  onChange={(e) => setDeliveryDate(e.target.value)}
                  className="ff-input text-sm"
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--ff-text-secondary)]">
                  Linked Sales Order (optional)
                </label>
                {loadingOrders ? (
                  <div className="ff-input flex items-center gap-2 text-sm text-[var(--ff-text-tertiary)]">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading...
                  </div>
                ) : (
                  <select
                    value={salesOrderId}
                    onChange={(e) => setSalesOrderId(e.target.value)}
                    disabled={!customerId}
                    className="ff-input text-sm disabled:opacity-50"
                  >
                    <option value="">None</option>
                    {salesOrders.map((so) => (
                      <option key={so.id} value={so.id}>{so.orderNumber}</option>
                    ))}
                  </select>
                )}
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs text-[var(--ff-text-secondary)]">Delivery Address</label>
                <input
                  value={deliveryAddress}
                  onChange={(e) => setDeliveryAddress(e.target.value)}
                  placeholder="Delivery address..."
                  className="ff-input text-sm"
                />
              </div>
            </div>

            <div className="flex flex-col gap-1">
              <label className="text-xs text-[var(--ff-text-secondary)]">Notes</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                placeholder="Additional notes..."
                className="ff-input text-sm resize-none"
              />
            </div>
          </div>

          <DeliveryNoteLineEditor lines={lines} onChange={setLines} />

          {/* Actions */}
          <div className="flex justify-end gap-3">
            <button
              onClick={() => router.push('/accounting/delivery-notes')}
              className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-secondary)] rounded-lg"
            >
              Cancel
            </button>
            <button
              onClick={() => handleSave(false)}
              disabled={saving}
              className="px-4 py-2 text-sm bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-primary)] rounded-lg disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save as Draft'}
            </button>
            <button
              onClick={() => handleSave(true)}
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 text-sm bg-teal-600 hover:bg-teal-500 text-white rounded-lg disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <>
                  <Truck className="h-4 w-4" /> Save &amp; Dispatch
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
