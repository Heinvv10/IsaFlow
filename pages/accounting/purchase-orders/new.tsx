/**
 * New Purchase Order Page
 * Route: /accounting/purchase-orders/new
 */
import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { ShoppingCart, Save, ArrowLeft, Loader2, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { apiFetch } from '@/lib/apiFetch';

interface Supplier { id: string; name: string; }
interface LineItem { productId: string; description: string; quantity: string; unitPrice: string; taxRate: string; }
const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export default function NewPurchaseOrderPage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [form, setForm] = useState({ supplierId: '', orderDate: new Date().toISOString().split('T')[0], expectedDeliveryDate: '', notes: '', reference: '' });
  const [items, setItems] = useState<LineItem[]>([{ productId: '', description: '', quantity: '1', unitPrice: '0', taxRate: '15' }]);

  useEffect(() => {
    apiFetch('/api/accounting/suppliers-list', { credentials: 'include' }).then(r => r.json()).then(j => setSuppliers(j.data || [])).catch(() => {});
  }, []);

  const addItem = () => setItems(prev => [...prev, { productId: '', description: '', quantity: '1', unitPrice: '0', taxRate: '15' }]);
  const removeItem = (idx: number) => setItems(prev => prev.filter((_, i) => i !== idx));
  const updateItem = (idx: number, field: string, value: string) => setItems(prev => prev.map((item, i) => i === idx ? { ...item, [field]: value } : item));

  const subtotal = items.reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unitPrice || 0), 0);
  const tax = items.reduce((s, i) => s + Number(i.quantity || 0) * Number(i.unitPrice || 0) * Number(i.taxRate || 0) / 100, 0);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/purchase-orders', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, items: items.map(i => ({ ...i, quantity: Number(i.quantity), unitPrice: Number(i.unitPrice), taxRate: Number(i.taxRate) })) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Failed');
      router.push('/accounting/purchase-orders');
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setSaving(false); }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <Link href="/accounting/purchase-orders" className="p-2 rounded-lg hover:bg-[var(--ff-bg-primary)]"><ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" /></Link>
            <div className="p-2 rounded-lg bg-orange-500/10"><ShoppingCart className="h-6 w-6 text-orange-500" /></div>
            <div><h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Purchase Order</h1><p className="text-sm text-[var(--ff-text-secondary)]">Create a purchase order for a supplier</p></div>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="p-6 max-w-4xl space-y-6">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Order Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Supplier *</label>
                <select required value={form.supplierId} onChange={e => setForm(p => ({ ...p, supplierId: e.target.value }))} className="ff-select w-full">
                  <option value="">Select supplier...</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Reference</label>
                <input type="text" value={form.reference} onChange={e => setForm(p => ({ ...p, reference: e.target.value }))} className="ff-input w-full" placeholder="Supplier quote ref" />
              </div>
              <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Order Date *</label>
                <input type="date" required value={form.orderDate} onChange={e => setForm(p => ({ ...p, orderDate: e.target.value }))} className="ff-input w-full" />
              </div>
              <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Expected Delivery</label>
                <input type="date" value={form.expectedDeliveryDate} onChange={e => setForm(p => ({ ...p, expectedDeliveryDate: e.target.value }))} className="ff-input w-full" />
              </div>
            </div>
          </div>
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Line Items</h2>
              <button type="button" onClick={addItem} className="inline-flex items-center gap-1 text-xs text-teal-400 hover:text-teal-300"><Plus className="h-3 w-3" /> Add Item</button>
            </div>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-[var(--ff-text-secondary)] border-b border-[var(--ff-border-light)]">
                <th className="pb-2">Description</th><th className="pb-2 w-24 text-right">Qty</th><th className="pb-2 w-32 text-right">Unit Price</th><th className="pb-2 w-20 text-right">VAT %</th><th className="pb-2 w-32 text-right">Total</th><th className="pb-2 w-10"></th>
              </tr></thead>
              <tbody>
                {items.map((item, idx) => {
                  const lineTotal = Number(item.quantity || 0) * Number(item.unitPrice || 0);
                  return (
                    <tr key={idx} className="border-b border-[var(--ff-border-light)]">
                      <td className="py-2 pr-2"><input type="text" required value={item.description} onChange={e => updateItem(idx, 'description', e.target.value)} className="ff-input w-full text-sm" placeholder="Item description" /></td>
                      <td className="py-2 pr-2"><input type="number" required min="0.01" step="0.01" value={item.quantity} onChange={e => updateItem(idx, 'quantity', e.target.value)} className="ff-input w-full text-sm text-right" /></td>
                      <td className="py-2 pr-2"><input type="number" required min="0" step="0.01" value={item.unitPrice} onChange={e => updateItem(idx, 'unitPrice', e.target.value)} className="ff-input w-full text-sm text-right" /></td>
                      <td className="py-2 pr-2"><input type="number" min="0" step="0.01" value={item.taxRate} onChange={e => updateItem(idx, 'taxRate', e.target.value)} className="ff-input w-full text-sm text-right" /></td>
                      <td className="py-2 text-right text-[var(--ff-text-primary)]">{fmt(lineTotal)}</td>
                      <td className="py-2">{items.length > 1 && <button type="button" onClick={() => removeItem(idx)} className="text-red-400 hover:text-red-300"><Trash2 className="h-3.5 w-3.5" /></button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="flex justify-end">
              <div className="text-sm space-y-1 w-48">
                <div className="flex justify-between"><span className="text-[var(--ff-text-secondary)]">Subtotal:</span><span className="text-[var(--ff-text-primary)]">{fmt(subtotal)}</span></div>
                <div className="flex justify-between"><span className="text-[var(--ff-text-secondary)]">VAT:</span><span className="text-[var(--ff-text-primary)]">{fmt(tax)}</span></div>
                <div className="flex justify-between font-bold border-t border-[var(--ff-border-light)] pt-1"><span className="text-[var(--ff-text-primary)]">Total:</span><span className="text-teal-400">{fmt(subtotal + tax)}</span></div>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <Link href="/accounting/purchase-orders" className="px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] text-sm">Cancel</Link>
            <button type="submit" disabled={saving} className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Create PO
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
