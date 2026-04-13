/**
 * New Purchase Order Page
 * Route: /accounting/purchase-orders/new
 */
import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ArrowLeft, Plus, Trash2, Loader2, Receipt } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { apiFetch } from '@/lib/apiFetch';

interface Supplier { id: string; name: string }
interface LineItem { key: string; description: string; quantity: string; unitPrice: string; taxRate: string }

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';
const fmt = (n: number) => `R ${new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)}`;

function SectionHeader({ num, title }: { num: string; title: string }) {
  return (
    <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
      <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">{num}</span>
      {title}
    </h3>
  );
}

export default function NewPurchaseOrderPage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saveAndNew, setSaveAndNew] = useState(false);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [form, setForm] = useState({
    supplierId: '', orderDate: new Date().toISOString().split('T')[0],
    expectedDeliveryDate: '', notes: '', reference: '',
  });
  const [items, setItems] = useState<LineItem[]>([
    { key: '1', description: '', quantity: '1', unitPrice: '0', taxRate: '15' },
  ]);

  useEffect(() => {
    apiFetch('/api/accounting/suppliers-list', { credentials: 'include' })
      .then(r => r.json())
      .then(j => {
        const d = j.data ?? j;
        setSuppliers(Array.isArray(d) ? d : (d.suppliers ?? []));
      })
      .catch(() => { /* non-critical */ });
  }, []);

  const addItem = () => setItems(prev => [...prev, { key: String(Date.now()), description: '', quantity: '1', unitPrice: '0', taxRate: '15' }]);
  const removeItem = (key: string) => setItems(prev => prev.length > 1 ? prev.filter(i => i.key !== key) : prev);
  const updateItem = (key: string, field: string, value: string) =>
    setItems(prev => prev.map(i => i.key === key ? { ...i, [field]: value } : i));

  const lineTotal = (i: LineItem) => Number(i.quantity || 0) * Number(i.unitPrice || 0);
  const subtotal = items.reduce((s, i) => s + lineTotal(i), 0);
  const tax = items.reduce((s, i) => s + lineTotal(i) * Number(i.taxRate || 0) / 100, 0);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>, andNew = false) => {
    e.preventDefault(); setError(''); setSaving(true); setSaveAndNew(andNew);
    try {
      const res = await apiFetch('/api/accounting/purchase-orders', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          items: items.map(i => ({ ...i, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice), taxRate: Number(i.taxRate) })),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Failed');
      if (andNew) {
        setForm({ supplierId: '', orderDate: new Date().toISOString().split('T')[0], expectedDeliveryDate: '', notes: '', reference: '' });
        setItems([{ key: '1', description: '', quantity: '1', unitPrice: '0', taxRate: '15' }]);
        await router.push('/accounting/purchase-orders/new');
      } else {
        await router.push(`/accounting/purchase-orders/${json.data?.id ?? ''}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        {/* Hero header */}
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10">
            <Link href="/accounting/purchase-orders" className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 mb-4 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Purchase Orders
            </Link>
            <div>
              <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">New Document</p>
              <h1 className="text-xl font-bold text-white">Purchase Order</h1>
            </div>
          </div>
        </div>

        <div className="p-6 xl:p-8">
          <form onSubmit={(e) => handleSubmit(e, saveAndNew)} className="max-w-6xl mx-auto flex gap-6 items-start">
            {/* Left column */}
            <div className="flex-1 min-w-0 space-y-5">
              {error && <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">{error}</div>}

              {/* Order Details */}
              <div className={`${card} p-5`}>
                <SectionHeader num="1" title="Order Details" />
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className={lbl}>Supplier *</label>
                    <select name="supplierId" required value={form.supplierId} onChange={e => setForm(p => ({ ...p, supplierId: e.target.value }))} className={inp}>
                      <option value="">Select supplier…</option>
                      {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className={lbl}>Reference</label>
                    <input type="text" name="reference" value={form.reference} onChange={e => setForm(p => ({ ...p, reference: e.target.value }))} placeholder="Supplier quote ref" className={inp} />
                  </div>
                  <div>
                    <label className={lbl}>Order Date *</label>
                    <input type="date" name="orderDate" required value={form.orderDate} onChange={e => setForm(p => ({ ...p, orderDate: e.target.value }))} className={inp} />
                  </div>
                  <div>
                    <label className={lbl}>Expected Delivery</label>
                    <input type="date" name="expectedDeliveryDate" value={form.expectedDeliveryDate} onChange={e => setForm(p => ({ ...p, expectedDeliveryDate: e.target.value }))} className={inp} />
                  </div>
                </div>
              </div>

              {/* Line Items */}
              <div className={`${card} overflow-hidden`}>
                <div className="px-5 py-4 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">2</span>
                    Line Items
                  </h3>
                  <button type="button" onClick={addItem} className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-white font-semibold transition-colors">
                    <Plus className="h-3 w-3" />Add Line
                  </button>
                </div>
                <div className="rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 dark:bg-slate-800/60">
                      <tr>
                        <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500">Description</th>
                        <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 w-20">Qty</th>
                        <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 w-32">Unit Price</th>
                        <th className="px-3 py-2.5 text-right text-xs font-semibold text-slate-500 w-20">VAT %</th>
                        <th className="px-4 py-2.5 text-right text-xs font-semibold text-slate-500 w-32">Total</th>
                        <th className="w-9" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                      {items.map(item => (
                        <tr key={item.key} className="group hover:bg-slate-50/50 dark:hover:bg-slate-800/20 transition-colors">
                          <td className="px-3 py-2"><input type="text" required name="description" value={item.description} onChange={e => updateItem(item.key, 'description', e.target.value)} placeholder="Item description" className={inp} /></td>
                          <td className="px-3 py-2"><input type="number" required name="quantity" min="0.01" step="0.01" value={item.quantity} onChange={e => updateItem(item.key, 'quantity', e.target.value)} className={`${inp} text-right`} /></td>
                          <td className="px-3 py-2"><input type="number" required name="unitPrice" min="0" step="0.01" value={item.unitPrice} onChange={e => updateItem(item.key, 'unitPrice', e.target.value)} className={`${inp} text-right`} /></td>
                          <td className="px-3 py-2"><input type="number" name="taxRate" min="0" step="0.01" value={item.taxRate} onChange={e => updateItem(item.key, 'taxRate', e.target.value)} className={`${inp} text-right`} /></td>
                          <td className="px-4 py-2 text-right font-mono text-sm font-semibold text-slate-800 dark:text-slate-200">{fmt(lineTotal(item))}</td>
                          <td className="px-2 py-2">
                            <button type="button" onClick={() => removeItem(item.key)} className="p-1.5 rounded-lg text-slate-300 dark:text-slate-700 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors opacity-0 group-hover:opacity-100">
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Notes */}
              <div className={`${card} p-5`}>
                <SectionHeader num="3" title="Notes" />
                <textarea name="notes" value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={3} placeholder="Add any notes or delivery instructions…" className={`${inp} resize-none`} />
              </div>
            </div>

            {/* Right column — sticky summary */}
            <div className="w-72 shrink-0">
              <div className="sticky top-6">
                <div className={`${card} p-5`}>
                  <div className="flex items-center gap-2 mb-5">
                    <Receipt className="w-4 h-4 text-amber-500" />
                    <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Order Summary</h3>
                  </div>
                  <div className="space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">Subtotal</span>
                      <span className="font-mono text-slate-900 dark:text-slate-100">{fmt(subtotal)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-slate-500 dark:text-slate-400">VAT</span>
                      <span className="font-mono text-slate-900 dark:text-slate-100">{fmt(tax)}</span>
                    </div>
                    <div className="h-px bg-slate-100 dark:bg-slate-800" />
                    <div className="flex justify-between">
                      <span className="text-sm font-semibold text-slate-900 dark:text-white">Total</span>
                      <span className="font-mono font-bold text-lg text-amber-500">{fmt(subtotal + tax)}</span>
                    </div>
                  </div>
                  <button type="submit" disabled={saving} onClick={() => setSaveAndNew(false)} className="w-full mt-6 py-3 bg-amber-500 hover:bg-amber-400 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                    {saving && !saveAndNew ? <><Loader2 className="h-4 w-4 animate-spin" />Creating…</> : 'Create Purchase Order'}
                  </button>
                  <button type="submit" disabled={saving} onClick={() => setSaveAndNew(true)} className="w-full mt-2 py-2.5 border border-amber-500 text-amber-600 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 font-semibold rounded-xl transition-colors disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                    {saving && saveAndNew ? <><Loader2 className="h-4 w-4 animate-spin" />Creating…</> : 'Save & New'}
                  </button>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
    </AppLayout>
  );
}
