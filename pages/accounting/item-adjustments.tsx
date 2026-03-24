/**
 * Item Adjustments Page
 * Sage Parity: Items > Transactions > Item Adjustments
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ArrowUpDown, Plus, Loader2, Check } from 'lucide-react';

const fmtQty = (n: number) => new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 4 }).format(n);

interface StockItem {
  id: string; item_code: string; item_name: string; uom: string; current_quantity: number;
}

export default function ItemAdjustmentsPage() {
  const [items, setItems] = useState<StockItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [form, setForm] = useState({
    itemId: '', adjustmentType: 'increase' as 'increase' | 'decrease',
    quantity: '', reason: '', date: new Date().toISOString().split('T')[0],
  });

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/accounting/item-adjustments', { credentials: 'include' });
    const json = await res.json();
    setItems(json.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true); setMsg('');
    const res = await fetch('/api/accounting/item-adjustments', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify(form),
    });
    if (res.ok) {
      setMsg('Adjustment saved'); setShowForm(false);
      setForm({ itemId: '', adjustmentType: 'increase', quantity: '', reason: '', date: new Date().toISOString().split('T')[0] });
      await load();
    } else {
      const json = await res.json();
      setMsg(json.error?.message || 'Failed');
    }
    setSaving(false);
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10"><ArrowUpDown className="h-6 w-6 text-blue-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Item Adjustments</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Adjust stock quantities with reason tracking</p>
              </div>
            </div>
            <button onClick={() => setShowForm(!showForm)}
              className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium">
              <Plus className="h-4 w-4" /> New Adjustment
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {msg && <div className={`p-3 rounded-lg text-sm flex items-center gap-2 ${msg.includes('saved') ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}><Check className="h-4 w-4" />{msg}</div>}

          {showForm && (
            <form onSubmit={submit} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-6 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Item</label>
                  <select value={form.itemId} onChange={e => setForm(f => ({ ...f, itemId: e.target.value }))} className="ff-input w-full" required>
                    <option value="">Select...</option>
                    {items.map(i => <option key={i.id} value={i.id}>{i.item_code} — {i.item_name} ({fmtQty(i.current_quantity)} {i.uom})</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Type</label>
                  <select value={form.adjustmentType} onChange={e => setForm(f => ({ ...f, adjustmentType: e.target.value as 'increase' | 'decrease' }))} className="ff-input w-full">
                    <option value="increase">Increase</option>
                    <option value="decrease">Decrease</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Quantity</label>
                  <input type="number" step="0.0001" min="0" value={form.quantity} onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} className="ff-input w-full" required />
                </div>
                <div>
                  <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Date</label>
                  <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} className="ff-input w-full" />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs text-[var(--ff-text-secondary)] mb-1">Reason</label>
                  <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} className="ff-input w-full" placeholder="e.g. Physical count correction" required />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 text-sm text-[var(--ff-text-secondary)]">Cancel</button>
                <button type="submit" disabled={saving} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm disabled:opacity-50">
                  {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
                </button>
              </div>
            </form>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {loading ? (
              <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" /></div>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Code</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Item</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Category</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">On Hand</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">UOM</th>
                </tr></thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {items.map(i => (
                    <tr key={i.id} className="hover:bg-[var(--ff-bg-tertiary)]">
                      <td className="px-4 py-3 font-mono text-xs text-[var(--ff-text-tertiary)]">{i.item_code}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-primary)]">{i.item_name}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{(i as unknown as Record<string, unknown>).category as string || '—'}</td>
                      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">{fmtQty(i.current_quantity)}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-tertiary)]">{i.uom}</td>
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
