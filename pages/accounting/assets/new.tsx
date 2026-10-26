/**
 * New Asset Page — two-column layout matching design system
 * Route: /accounting/assets/new
 */

import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/ui';
import { AssetFinancialFields, card, inp, lbl } from '@/components/accounting/assets/AssetFinancialFields';
import { Package, Loader2, Database } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { localISODate } from '@/lib/dateUtils';
import { formatMoney } from '@/lib/money/formatMoney';

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
  const [dateError, setDateError] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<Category | null>(null);

  const [form, setForm] = useState({
    name: '',
    description: '',
    category: '',
    sarsCategory: '',
    serialNumber: '',
    location: '',
    purchaseDate: localISODate(),
    cost: '',
    salvageValue: '0',
    usefulLifeYears: '',
    depreciationMethod: 'straight_line',
    status: 'available',
  });

  useEffect(() => {
    apiFetch('/api/accounting/assets-categories', { credentials: 'include' })
      .then(async r => { await assertOk(r, 'Could not load asset categories - try again'); return r.json(); })
      .then(j => setCategories(j.data || []))
      .catch(err => { setCategories([]); setError(apiErrorMessage(err, 'Could not load asset categories - try again')); });
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
    if (!form.purchaseDate) {
      setDateError('Enter the purchase date.');
      return;
    }
    setDateError('');
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
      await assertOk(res, 'Could not create the asset - try again');
      try { await router.push('/accounting/assets'); } catch (e) { log.warn('navigation failed', { error: e }, 'assets-new'); }
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not create the asset - try again'));
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
        <PageHeader
          icon={Package}
          title="New Asset"
          backLink={{ label: 'Back to Assets', href: '/accounting/assets' }}
          className="mb-0"
        />

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

                <AssetFinancialFields form={form} update={update} dateError={dateError} />
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
                          <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Name</p>
                          <p className="text-sm text-slate-900 dark:text-slate-100 font-medium mt-0.5 truncate">{form.name}</p>
                        </div>
                      )}
                      {selectedCategory && (
                        <div>
                          <p className="text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">Category</p>
                          <p className="text-sm text-slate-900 dark:text-slate-100 mt-0.5">{selectedCategory.name}</p>
                          <p className="text-xs text-slate-500 dark:text-slate-400">{selectedCategory.sars_rate}% / yr</p>
                        </div>
                      )}
                      {form.cost && (
                        <>
                          <div className="h-px bg-slate-100 dark:bg-slate-800" />
                          <div className="flex justify-between text-sm">
                            <span className="text-slate-500 dark:text-slate-400">Cost</span>
                            <span className="tabular-nums text-slate-900 dark:text-slate-100">{formatMoney(Number(form.cost))}</span>
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-slate-500 dark:text-slate-400">Salvage</span>
                            <span className="tabular-nums text-slate-900 dark:text-slate-100">{formatMoney(Number(form.salvageValue || 0))}</span>
                          </div>
                          {depreciatedValue && (
                            <>
                              <div className="h-px bg-slate-100 dark:bg-slate-800" />
                              <div className="flex justify-between">
                                <span className="text-sm font-semibold text-slate-900 dark:text-white">Depreciable</span>
                                <span className="tabular-nums font-bold text-amber-500">{formatMoney(Number(depreciatedValue))}</span>
                              </div>
                            </>
                          )}
                        </>
                      )}
                    </div>

                    <button type="submit" disabled={saving}
                      className="w-full py-3 bg-brand-600 hover:bg-brand-700 text-white font-semibold rounded-xl transition-colors shadow-lg shadow-amber-500/20 disabled:opacity-50 flex items-center justify-center gap-2 text-sm">
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
