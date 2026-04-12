/**
 * New Asset Page — two-column layout matching design system
 * Route: /accounting/assets/new
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Package, ArrowLeft, Loader2, Database } from 'lucide-react';
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

const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';
const lbl = 'block text-[11px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5';
const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';

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
      .catch(() => { setCategories([]); });
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

  const update = (field: string, value: string) => setForm(prev => ({ ...prev, [field]: value }));

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
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

  const depreciatedValue = form.cost && form.salvageValue
    ? (Number(form.cost) - Number(form.salvageValue)).toFixed(2)
    : null;

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        {/* Page header */}
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10">
            <Link href="/accounting/assets" className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 mb-4 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Assets
            </Link>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center">
                <Package className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">New Record</p>
                <h1 className="text-xl font-bold text-white">New Asset</h1>
              </div>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="p-6 xl:p-8">
            <div className="max-w-6xl mx-auto flex gap-6 items-start">
              {/* Left column */}
              <div className="flex-1 min-w-0 space-y-5">
                {error && (
                  <div className="p-3 bg-red-50 dark:bg-red-900/20 rounded-xl border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 text-sm">
                    {error}
                  </div>
                )}

                {/* Section 1 — Asset Details */}
                <div className={`${card} p-5`}>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">1</span>
                    Asset Details
                  </h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={lbl}>Name *</label>
                      <input type="text" name="name" required value={form.name}
                        onChange={e => update('name', e.target.value)}
                        placeholder="Dell Laptop XPS 15" className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>Serial Number</label>
                      <input type="text" name="serialNumber" value={form.serialNumber}
                        onChange={e => update('serialNumber', e.target.value)}
                        placeholder="SN-12345" className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>Location</label>
                      <input type="text" name="location" value={form.location}
                        onChange={e => update('location', e.target.value)}
                        placeholder="Head Office" className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>Status</label>
                      <select name="status" value={form.status}
                        onChange={e => update('status', e.target.value)} className={inp}>
                        <option value="available">Available</option>
                        <option value="assigned">Assigned</option>
                        <option value="in_maintenance">In Maintenance</option>
                      </select>
                    </div>
                    <div className="col-span-2">
                      <label className={lbl}>Description</label>
                      <textarea name="description" value={form.description}
                        onChange={e => update('description', e.target.value)}
                        rows={2} className={`${inp} resize-none`} />
                    </div>
                  </div>
                </div>

                {/* Section 2 — SARS Category & Depreciation */}
                <div className={`${card} p-5`}>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">2</span>
                    SARS Wear-and-Tear Category
                  </h3>
                  <div className="space-y-4">
                    <div>
                      <label className={lbl}>Category *</label>
                      <select name="category" required value={form.category}
                        onChange={e => handleCategoryChange(e.target.value)} className={inp}>
                        <option value="">Select category…</option>
                        {categories.map(c => (
                          <option key={c.code} value={c.code}>
                            {c.name} ({c.sars_rate}% — {c.sars_years} years)
                          </option>
                        ))}
                      </select>
                    </div>
                    {selectedCategory && (
                      <div className="p-3 rounded-xl bg-amber-500/5 border border-amber-500/20 text-sm space-y-1">
                        <p className="text-amber-600 dark:text-amber-400 font-semibold">{selectedCategory.name}</p>
                        <p className="text-slate-600 dark:text-slate-400">{selectedCategory.description}</p>
                        <p className="text-slate-500 dark:text-slate-400">
                          SARS Rate: {selectedCategory.sars_rate}% per year ({selectedCategory.sars_years} year useful life)
                        </p>
                      </div>
                    )}
                    <div>
                      <label className={lbl}>Depreciation Method *</label>
                      <select name="depreciationMethod" value={form.depreciationMethod}
                        onChange={e => update('depreciationMethod', e.target.value)} className={inp}>
                        {DEPRECIATION_METHODS.map(m => (
                          <option key={m.value} value={m.value}>{m.label}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>

                {/* Section 3 — Financial Details */}
                <div className={`${card} p-5`}>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">3</span>
                    Financial Details
                  </h3>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={lbl}>Purchase Date *</label>
                      <input type="date" name="purchaseDate" required value={form.purchaseDate}
                        onChange={e => update('purchaseDate', e.target.value)} className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>Cost (Purchase Price) *</label>
                      <input type="number" name="cost" required step="0.01" min="0.01" value={form.cost}
                        onChange={e => update('cost', e.target.value)}
                        placeholder="25000.00" className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>Salvage (Residual) Value</label>
                      <input type="number" name="salvageValue" step="0.01" min="0" value={form.salvageValue}
                        onChange={e => update('salvageValue', e.target.value)}
                        placeholder="0.00" className={inp} />
                    </div>
                    <div>
                      <label className={lbl}>Useful Life (years) *</label>
                      <input type="number" name="usefulLifeYears" required step="0.5" min="0.5" value={form.usefulLifeYears}
                        onChange={e => update('usefulLifeYears', e.target.value)} className={inp} />
                    </div>
                  </div>
                </div>
              </div>

              {/* Right column — sticky summary */}
              <div className="w-72 shrink-0">
                <div className="sticky top-6">
                  <div className={`${card} p-5`}>
                    <div className="flex items-center gap-2 mb-5">
                      <Database className="w-4 h-4 text-amber-500" />
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Asset Summary</h3>
                    </div>

                    <div className="space-y-3 mb-5">
                      {form.name && (
                        <div>
                          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Name</p>
                          <p className="text-sm text-slate-900 dark:text-slate-100 font-medium mt-0.5 truncate">{form.name}</p>
                        </div>
                      )}
                      {selectedCategory && (
                        <div>
                          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Category</p>
                          <p className="text-sm text-slate-900 dark:text-slate-100 mt-0.5">{selectedCategory.name}</p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">{selectedCategory.sars_rate}% / yr</p>
                        </div>
                      )}
                      {form.cost && (
                        <>
                          <div className="h-px bg-slate-100 dark:bg-slate-800" />
                          <div className="flex justify-between text-sm">
                            <span className="text-slate-500 dark:text-slate-400">Cost</span>
                            <span className="font-mono text-slate-900 dark:text-slate-100">R {Number(form.cost).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}</span>
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-slate-500 dark:text-slate-400">Salvage</span>
                            <span className="font-mono text-slate-900 dark:text-slate-100">R {Number(form.salvageValue || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}</span>
                          </div>
                          {depreciatedValue && (
                            <>
                              <div className="h-px bg-slate-100 dark:bg-slate-800" />
                              <div className="flex justify-between">
                                <span className="text-sm font-semibold text-slate-900 dark:text-white">Depreciable</span>
                                <span className="font-mono font-bold text-amber-500">R {Number(depreciatedValue).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}</span>
                              </div>
                            </>
                          )}
                        </>
                      )}
                    </div>

                    <button type="submit" disabled={saving}
                      className="w-full py-3 bg-amber-500 hover:bg-amber-400 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
                      {saving
                        ? <><Loader2 className="h-4 w-4 animate-spin" />Saving…</>
                        : <><Package className="h-4 w-4" />Create Asset</>}
                    </button>
                    <Link href="/accounting/assets"
                      className="w-full mt-2 py-2 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 flex items-center justify-center transition-colors">
                      Cancel
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
