/**
 * New Product Page
 * Route: /accounting/products/new
 */
import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Box, Save, ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { apiFetch } from '@/lib/apiFetch';

interface Category { id: string; name: string; code: string; }

export default function NewProductPage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [form, setForm] = useState({
    name: '', code: '', description: '', category: '', barcode: '', unit: 'each',
    type: 'inventory', costPrice: '', sellingPrice: '', costMethod: 'weighted_average',
    taxRate: '15', reorderLevel: '0', reorderQuantity: '0',
  });

  useEffect(() => {
    apiFetch('/api/accounting/products-categories', { credentials: 'include' })
      .then(r => r.json()).then(j => setCategories(j.data || [])).catch(() => {});
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(''); setSaving(true);
    try {
      const res = await apiFetch('/api/accounting/products', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, costPrice: Number(form.costPrice), sellingPrice: Number(form.sellingPrice), reorderLevel: Number(form.reorderLevel), reorderQuantity: Number(form.reorderQuantity), taxRate: Number(form.taxRate) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Failed');
      router.push('/accounting/products');
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
    finally { setSaving(false); }
  };

  const update = (f: string, v: string) => setForm(prev => ({ ...prev, [f]: v }));

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <Link href="/accounting/products" className="p-2 rounded-lg hover:bg-[var(--ff-bg-primary)]"><ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" /></Link>
            <div className="p-2 rounded-lg bg-blue-500/10"><Box className="h-6 w-6 text-blue-500" /></div>
            <div><h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Product</h1><p className="text-sm text-[var(--ff-text-secondary)]">Add a new inventory item or service</p></div>
          </div>
        </div>
        <form onSubmit={handleSubmit} className="p-6 max-w-3xl space-y-6">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Product Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Name *</label><input type="text" required value={form.name} onChange={e => update('name', e.target.value)} className="ff-input w-full" /></div>
              <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Code *</label><input type="text" required value={form.code} onChange={e => update('code', e.target.value)} className="ff-input w-full" placeholder="PRD-0001" /></div>
            </div>
            <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Description</label><textarea value={form.description} onChange={e => update('description', e.target.value)} className="ff-input w-full" rows={2} /></div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Category</label><select value={form.category} onChange={e => update('category', e.target.value)} className="ff-select w-full"><option value="">Select...</option>{categories.map(c => <option key={c.code} value={c.code}>{c.name}</option>)}</select></div>
              <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Type *</label><select value={form.type} onChange={e => update('type', e.target.value)} className="ff-select w-full"><option value="inventory">Inventory</option><option value="non_inventory">Non-Inventory</option><option value="service">Service</option></select></div>
              <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Unit</label><input type="text" value={form.unit} onChange={e => update('unit', e.target.value)} className="ff-input w-full" /></div>
            </div>
            <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Barcode</label><input type="text" value={form.barcode} onChange={e => update('barcode', e.target.value)} className="ff-input w-full" /></div>
          </div>
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Pricing & Costing</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Cost Price (ZAR)</label><input type="number" step="0.01" min="0" value={form.costPrice} onChange={e => update('costPrice', e.target.value)} className="ff-input w-full" /></div>
              <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Selling Price (ZAR)</label><input type="number" step="0.01" min="0" value={form.sellingPrice} onChange={e => update('sellingPrice', e.target.value)} className="ff-input w-full" /></div>
              <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Cost Method</label><select value={form.costMethod} onChange={e => update('costMethod', e.target.value)} className="ff-select w-full"><option value="weighted_average">Weighted Average</option><option value="fifo">FIFO</option></select></div>
              <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">VAT Rate (%)</label><input type="number" step="0.01" value={form.taxRate} onChange={e => update('taxRate', e.target.value)} className="ff-input w-full" /></div>
            </div>
          </div>
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Stock Management</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Reorder Level</label><input type="number" min="0" value={form.reorderLevel} onChange={e => update('reorderLevel', e.target.value)} className="ff-input w-full" /></div>
              <div><label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Reorder Quantity</label><input type="number" min="0" value={form.reorderQuantity} onChange={e => update('reorderQuantity', e.target.value)} className="ff-input w-full" /></div>
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <Link href="/accounting/products" className="px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] text-sm">Cancel</Link>
            <button type="submit" disabled={saving} className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Product
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
