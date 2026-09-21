/**
 * New Goods Received Note Page — select a confirmed PO and record receipt
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, PackageCheck, Loader2, Receipt } from 'lucide-react';
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

function remainingQuantity(item: POItem): number {
  return Math.max(0, Math.round(Number(item.quantity) * 100) - Math.round(Number(item.quantity_received || 0) * 100)) / 100;
}

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

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
    Promise.all(['approved', 'partially_received'].map(async (status) => {
      const response = await apiFetch(`/api/accounting/purchase-orders?status=${status}`);
      if (!response.ok) throw new Error('Failed to load purchase orders');
      const json = await response.json();
      const data = json.data || json;
      return Array.isArray(data) ? data as PurchaseOrder[] : [];
    }))
      .then((orders) => setPos(orders.flat()))
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
    apiFetch(`/api/accounting/purchase-orders/${selectedPO}`)
      .then((r) => r.json())
      .then((json) => {
        const d = json.data || json;
        const items: POItem[] = Array.isArray(d.items) ? d.items : [];
        setPoItems(items);
        const qtys: Record<string, number> = {};
        for (const item of items) {
          const remaining = remainingQuantity(item);
          qtys[item.id] = remaining;
        }
        setReceivedQtys(qtys);
      })
      .catch(() => setPoItems([]))
      .finally(() => setLoadingItems(false));
  }, [selectedPO]);

  const totalItems = Object.values(receivedQtys).reduce((s, q) => s + q, 0);

  const handleSubmit = async () => {
    if (!selectedPO) { setError('Please select a purchase order'); return; }
    const items = poItems
      .filter((item) => (receivedQtys[item.id] ?? 0) > 0)
      .map((item) => ({ poItemId: item.id, quantityReceived: receivedQtys[item.id] ?? 0, quantityRejected: 0 }));
    if (items.length === 0) { setError('Enter at least one received quantity'); return; }
    setSaving(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/goods-received', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ purchaseOrderId: selectedPO, receivedDate, receivedBy: deliveryNote || null, notes: notes || null, items }),
      });
      const json = await res.json();
      if (!res.ok) { setError(json?.error?.message || 'Failed to create GRN'); return; }
      await router.push('/accounting/goods-received');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10">
            <Link href="/accounting/goods-received" className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 hover:text-slate-200 mb-4 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Goods Received
            </Link>
            <div>
              <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">New Document</p>
              <h1 className="text-xl font-bold text-slate-900 dark:text-white">New Goods Received Note</h1>
            </div>
          </div>
        </div>

        <div className="p-6 xl:p-8">
          <div className="max-w-6xl mx-auto flex gap-6 items-start">
            {/* Left column */}
            <div className="flex-1 min-w-0 space-y-5">
              {error && (
                <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
                  {error}
                </div>
              )}

              {/* Details card */}
              <div className={`${card} p-5`}>
                <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                  <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">1</span>
                  Receipt Details
                </h3>
                <div className="space-y-4">
                  <div>
                    <label className={lbl}>Purchase Order *</label>
                    {loadingPOs ? (
                      <Loader2 className="h-4 w-4 animate-spin text-slate-500 dark:text-slate-400" />
                    ) : (
                      <select name="selectedPO" value={selectedPO} onChange={(e) => setSelectedPO(e.target.value)} className={inp}>
                        <option value="">Select a confirmed purchase order...</option>
                        {pos.map((po) => (
                          <option key={po.id} value={po.id}>{po.po_number} — {po.supplier_name}</option>
                        ))}
                      </select>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={lbl}>Receipt Date *</label>
                      <input type="date" name="receivedDate" value={receivedDate} onChange={(e) => setReceivedDate(e.target.value)} className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>Delivery Note #</label>
                      <input name="deliveryNote" value={deliveryNote} onChange={(e) => setDeliveryNote(e.target.value)} placeholder="Supplier delivery note reference" className={inp} />
                    </div>
                  </div>
                  <div>
                    <label className={lbl}>Notes</label>
                    <input name="notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional notes" className={inp} />
                  </div>
                </div>
              </div>

              {/* Line Items */}
              {selectedPO && (
                <div className={`${card} overflow-hidden`}>
                  <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                      <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">2</span>
                      Line Items
                    </h3>
                  </div>
                  {loadingItems ? (
                    <div className="p-12 flex items-center justify-center">
                      <Loader2 className="h-5 w-5 animate-spin text-slate-500 dark:text-slate-400" />
                    </div>
                  ) : poItems.length === 0 ? (
                    <div className="p-12 text-center text-slate-500 dark:text-slate-400 text-sm">
                      No items found for this purchase order
                    </div>
                  ) : (
                    <table className="w-full text-sm">
                      <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-100 dark:border-slate-800">
                        <tr>
                          <th className="px-5 py-2.5 text-left text-xs font-semibold text-slate-500 dark:text-slate-400">Description</th>
                          <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-24">Ordered</th>
                          <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-32">Prev. Received</th>
                          <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 dark:text-slate-400 w-32">Receiving Now</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {poItems.map((item) => (
                          <tr key={item.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-colors">
                            <td className="px-5 py-3.5 text-slate-900 dark:text-slate-100">{item.description}</td>
                            <td className="px-3 py-3.5 text-right font-mono text-slate-500 dark:text-slate-400">{item.quantity}</td>
                            <td className="px-3 py-3.5 text-right font-mono text-slate-500 dark:text-slate-400">{item.quantity_received || 0}</td>
                            <td className="px-4 py-3 text-right">
                              <input
                                type="number"
                                min={0}
                                step={0.01}
                                max={remainingQuantity(item)}
                                value={receivedQtys[item.id] ?? 0}
                                onChange={(e) => setReceivedQtys((prev) => ({ ...prev, [item.id]: Number(e.target.value) }))}
                                className={`${inp} text-right w-24`}
                              />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              )}
            </div>

            {/* Right column — sticky summary */}
            <div className="w-72 shrink-0">
              <div className="sticky top-6">
                <div className={`${card} p-5`}>
                  <div className="flex items-center gap-2 mb-5">
                    <Receipt className="w-4 h-4 text-amber-500" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Summary</h3>
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">PO Selected</span>
                      <span className="font-medium text-slate-900 dark:text-slate-100">{selectedPO ? 'Yes' : '—'}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">Total Items</span>
                      <span className="font-mono font-semibold text-slate-900 dark:text-slate-100">{totalItems}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">Date</span>
                      <span className="font-mono text-xs text-slate-700 dark:text-slate-300">{receivedDate || '—'}</span>
                    </div>
                  </div>
                  <button
                    onClick={handleSubmit}
                    disabled={saving || !selectedPO}
                    className="w-full mt-6 py-3 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm"
                  >
                    {saving ? <><Loader2 className="h-4 w-4 animate-spin" />Saving…</> : <><PackageCheck className="h-4 w-4" />Create GRN</>}
                  </button>
                  <Link href="/accounting/goods-received" className="block mt-3 text-center text-xs text-slate-500 dark:text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 transition-colors">
                    Cancel
                  </Link>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
