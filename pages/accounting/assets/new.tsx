/**
 * New Asset Page
 * Form for creating a new fixed asset with SARS category selection.
 * Route: /accounting/assets/new
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Package, Save, ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { apiFetch } from '@/lib/apiFetch';

interface Category {
  id: string;
  name: string;
  code: string;
  sars_rate: number;
  sars_years: number;
  description: string;
}

const DEPRECIATION_METHODS = [
  { value: 'straight_line', label: 'Straight-Line' },
  { value: 'reducing_balance', label: 'Reducing Balance' },
  { value: 'sum_of_years', label: 'Sum-of-Years Digits' },
];

export default function NewAssetPage() {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);

  const [form, setForm] = useState({
    name: '',
    description: '',
    category: '',
    sarsCategory: '',
    serialNumber: '',
    location: '',
    purchaseDate: new Date().toISOString().split('T')[0],
    cost: '',
    salvageValue: '0',
    usefulLifeYears: '',
    depreciationMethod: 'straight_line',
    status: 'available',
  });

  useEffect(() => {
    apiFetch('/api/accounting/assets-categories', { credentials: 'include' })
      .then(r => r.json())
      .then(j => setCategories(j.data || []))
      .catch(() => {});
  }, []);

  const handleCategoryChange = (code: string) => {
    const cat = categories.find(c => c.code === code);
    setSelectedCategory(cat || null);
    setForm(prev => ({
      ...prev,
      category: code,
      sarsCategory: code,
      usefulLifeYears: cat ? String(cat.sars_years) : prev.usefulLifeYears,
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSaving(true);

    try {
      const res = await apiFetch('/api/accounting/assets', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          cost: Number(form.cost),
          salvageValue: Number(form.salvageValue),
          usefulLifeYears: Number(form.usefulLifeYears),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Failed to create asset');
      router.push('/accounting/assets');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setSaving(false);
    }
  };

  const update = (field: string, value: string) => setForm(prev => ({ ...prev, [field]: value }));

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <Link href="/accounting/assets" className="p-2 rounded-lg hover:bg-[var(--ff-bg-primary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-purple-500/10">
              <Package className="h-6 w-6 text-purple-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Asset</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">Register a new fixed asset</p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 max-w-3xl space-y-6">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>
          )}

          {/* Basic Info */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Asset Details</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Name *</label>
                <input type="text" required value={form.name} onChange={e => update('name', e.target.value)}
                  className="ff-input w-full" placeholder="Dell Laptop XPS 15" />
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Serial Number</label>
                <input type="text" value={form.serialNumber} onChange={e => update('serialNumber', e.target.value)}
                  className="ff-input w-full" placeholder="SN-12345" />
              </div>
            </div>

            <div>
              <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Description</label>
              <textarea value={form.description} onChange={e => update('description', e.target.value)}
                className="ff-input w-full" rows={2} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Location</label>
                <input type="text" value={form.location} onChange={e => update('location', e.target.value)}
                  className="ff-input w-full" placeholder="Head Office" />
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Status</label>
                <select value={form.status} onChange={e => update('status', e.target.value)} className="ff-select w-full">
                  <option value="available">Available</option>
                  <option value="assigned">Assigned</option>
                  <option value="in_maintenance">In Maintenance</option>
                </select>
              </div>
            </div>
          </div>

          {/* SARS Category & Depreciation */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">SARS Wear-and-Tear Category</h2>

            <div>
              <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Category *</label>
              <select value={form.category} onChange={e => handleCategoryChange(e.target.value)} className="ff-select w-full" required>
                <option value="">Select category...</option>
                {categories.map(c => (
                  <option key={c.code} value={c.code}>{c.name} ({c.sars_rate}% — {c.sars_years} years)</option>
                ))}
              </select>
            </div>

            {selectedCategory && (
              <div className="p-3 rounded-lg bg-purple-500/5 border border-purple-500/20 text-sm">
                <p className="text-purple-400 font-medium">{selectedCategory.name}</p>
                <p className="text-[var(--ff-text-secondary)]">{selectedCategory.description}</p>
                <p className="text-[var(--ff-text-secondary)] mt-1">
                  SARS Rate: {selectedCategory.sars_rate}% per year ({selectedCategory.sars_years} year useful life)
                </p>
              </div>
            )}

            <div>
              <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Depreciation Method *</label>
              <select value={form.depreciationMethod} onChange={e => update('depreciationMethod', e.target.value)} className="ff-select w-full">
                {DEPRECIATION_METHODS.map(m => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Financial */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Financial Details</h2>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Purchase Date *</label>
                <input type="date" required value={form.purchaseDate} onChange={e => update('purchaseDate', e.target.value)}
                  className="ff-input w-full" />
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Cost (Purchase Price) *</label>
                <input type="number" required step="0.01" min="0.01" value={form.cost}
                  onChange={e => update('cost', e.target.value)} className="ff-input w-full" placeholder="25000.00" />
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Salvage (Residual) Value</label>
                <input type="number" step="0.01" min="0" value={form.salvageValue}
                  onChange={e => update('salvageValue', e.target.value)} className="ff-input w-full" placeholder="0.00" />
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Useful Life (years) *</label>
                <input type="number" required step="0.5" min="0.5" value={form.usefulLifeYears}
                  onChange={e => update('usefulLifeYears', e.target.value)} className="ff-input w-full" />
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-3">
            <Link href="/accounting/assets" className="px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] text-sm hover:bg-[var(--ff-bg-secondary)]">
              Cancel
            </Link>
            <button type="submit" disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save Asset
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
