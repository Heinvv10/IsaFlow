/**
 * New Goods Received Note Page — select a confirmed PO and record receipt
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { PackageCheck, ArrowLeft, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface PurchaseOrder {
  id: string;
  po_number: string;
  supplier_name: string;
  total: number;
}

interface POItem {
  id: string;
  description: string;
  quantity: number;
  quantity_received: number;
}

export default function NewGRNPage() {
  const router = useRouter();
  const [pos, setPos] = useState<PurchaseOrder[]>([]);
  const [selectedPO, setSelectedPO] = useState('');
  const [poItems, setPoItems] = useState<POItem[]>([]);
  const [receivedQtys, setReceivedQtys] = useState<Record<string, number>>({});
  const [receivedDate, setReceivedDate] = useState(new Date().toISOString().split('T')[0] ?? '');
  const [deliveryNote, setDeliveryNote] = useState('');
  const [notes, setNotes] = useState('');
  const [loadingPOs, setLoadingPOs] = useState(true);
  const [loadingItems, setLoadingItems] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    apiFetch('/api/accounting/purchase-orders?status=approved')
      .then((r) => r.json())
      .then((json) => {
        const d = json.data || json;
        setPos(Array.isArray(d) ? d : []);
      })
      .catch(() => setPos([]))
      .finally(() => setLoadingPOs(false));
  }, []);

  useEffect(() => {
    if (!selectedPO) {
      setPoItems([]);
      setReceivedQtys({});
      return;
    }
    setLoadingItems(true);
    apiFetch(`/api/accounting/purchase-orders?id=${selectedPO}`)
      .then((r) => r.json())
      .then((json) => {
        const d = json.data || json;
        const items: POItem[] = Array.isArray(d.items) ? d.items : [];
        setPoItems(items);
        const qtys: Record<string, number> = {};
        for (const item of items) {
          const remaining = Math.max(0, Number(item.quantity) - Number(item.quantity_received || 0));
          qtys[item.id] = remaining;
        }
        setReceivedQtys(qtys);
      })
      .catch(() => setPoItems([]))
      .finally(() => setLoadingItems(false));
  }, [selectedPO]);

  const handleSubmit = async () => {
    if (!selectedPO) {
      setError('Please select a purchase order');
      return;
    }
    const items = poItems
      .filter((item) => (receivedQtys[item.id] ?? 0) > 0)
      .map((item) => ({
        poItemId: item.id,
        quantityReceived: receivedQtys[item.id] ?? 0,
        quantityRejected: 0,
      }));
    if (items.length === 0) {
      setError('Enter at least one received quantity');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/goods-received', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          purchaseOrderId: selectedPO,
          receivedDate,
          receivedBy: deliveryNote || null,
          notes: notes || null,
          items,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json?.error?.message || 'Failed to create GRN');
        return;
      }
      await router.push('/accounting/goods-received');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <button
              onClick={() => router.push('/accounting/goods-received')}
              className="p-1.5 rounded hover:bg-[var(--ff-bg-tertiary)] text-[var(--ff-text-secondary)]"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div className="p-2 rounded-lg bg-teal-500/10">
              <PackageCheck className="h-6 w-6 text-teal-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Goods Received Note</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Record goods received against a purchase order</p>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-3xl space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg px-4 py-3 text-sm">
              {error}
            </div>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4 space-y-4">
            {/* PO Selector */}
            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] uppercase mb-1">
                Purchase Order *
              </label>
              {loadingPOs ? (
                <Loader2 className="h-4 w-4 animate-spin text-[var(--ff-text-tertiary)]" />
              ) : (
                <select
                  value={selectedPO}
                  onChange={(e) => setSelectedPO(e.target.value)}
                  className="ff-input text-sm w-full"
                >
                  <option value="">Select a confirmed purchase order...</option>
                  {pos.map((po) => (
                    <option key={po.id} value={po.id}>
                      {po.po_number} — {po.supplier_name}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {/* Receipt Details */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] uppercase mb-1">
                  Receipt Date *
                </label>
                <input
                  type="date"
                  value={receivedDate}
                  onChange={(e) => setReceivedDate(e.target.value)}
                  className="ff-input text-sm w-full"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-[var(--ff-text-secondary)] uppercase mb-1">
                  Delivery Note #
                </label>
                <input
                  value={deliveryNote}
                  onChange={(e) => setDeliveryNote(e.target.value)}
                  placeholder="Supplier delivery note reference"
                  className="ff-input text-sm w-full"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-[var(--ff-text-secondary)] uppercase mb-1">
                Notes
              </label>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Optional notes"
                className="ff-input text-sm w-full"
              />
            </div>
          </div>

          {/* Line Items */}
          {selectedPO && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <div className="px-4 py-3 border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                <h3 className="text-sm font-medium text-[var(--ff-text-primary)]">Line Items</h3>
              </div>
              {loadingItems ? (
                <div className="p-6 text-center">
                  <Loader2 className="h-5 w-5 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
                </div>
              ) : poItems.length === 0 ? (
                <div className="p-6 text-center text-[var(--ff-text-secondary)] text-sm">
                  No items found for this purchase order
                </div>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-[var(--ff-border-light)]">
                      <th className="px-4 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Description</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Ordered</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Previously Received</th>
                      <th className="px-4 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Receiving Now</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--ff-border-light)]">
                    {poItems.map((item) => (
                      <tr key={item.id}>
                        <td className="px-4 py-3 text-sm text-[var(--ff-text-primary)]">{item.description}</td>
                        <td className="px-4 py-3 text-sm text-right text-[var(--ff-text-secondary)] font-mono">{item.quantity}</td>
                        <td className="px-4 py-3 text-sm text-right text-[var(--ff-text-secondary)] font-mono">{item.quantity_received || 0}</td>
                        <td className="px-4 py-3 text-right">
                          <input
                            type="number"
                            min={0}
                            max={Math.max(0, Number(item.quantity) - Number(item.quantity_received || 0))}
                            value={receivedQtys[item.id] ?? 0}
                            onChange={(e) =>
                              setReceivedQtys((prev) => ({
                                ...prev,
                                [item.id]: Number(e.target.value),
                              }))
                            }
                            className="ff-input text-sm w-24 text-right"
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              onClick={() => router.push('/accounting/goods-received')}
              className="px-4 py-2 text-sm text-[var(--ff-text-secondary)] hover:bg-[var(--ff-bg-secondary)] rounded-lg"
            >
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={saving || !selectedPO}
              className="flex items-center gap-1.5 px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-lg text-sm disabled:opacity-50"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {saving ? 'Saving...' : 'Create GRN'}
            </button>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
