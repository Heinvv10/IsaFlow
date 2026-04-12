/**
 * New Item Page — two-column layout matching design system
 * Route: /accounting/items/new
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Package, ArrowLeft, Loader2, Database } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { apiFetch } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';
import {
  ItemDetailsSection,
  PricingSection,
  VatAccountsSection,
  OpeningBalancesSection,
} from '@/components/accounting/items/ItemFormSections';

interface Category { id: string; name: string }
interface Account { id: string; account_number: string; name: string }

const DEFAULT_VAT_RATE = 0.15;

type FormState = {
  code: string;
  description: string;
  category_id: string;
  item_type: 'physical' | 'service';
  is_active: boolean;
  unit: string;
  cost_price: string;
  selling_price_excl: string;
  selling_price_incl: string;
  gp_percent: string;
  vat_on_sales: string;
  vat_on_purchases: string;
  sales_account_id: string;
  purchases_account_id: string;
  opening_qty: string;
  opening_cost: string;
  opening_date: string;
  notes: string;
};

const BLANK: FormState = {
  code: '', description: '', category_id: '', item_type: 'physical',
  is_active: true, unit: 'each', cost_price: '', selling_price_excl: '',
  selling_price_incl: '', gp_percent: '', vat_on_sales: 'standard',
  vat_on_purchases: 'standard', sales_account_id: '', purchases_account_id: '',
  opening_qty: '', opening_cost: '', opening_date: '', notes: '',
};

const card = 'bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm';
const inp = 'w-full px-3 py-2 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 transition-colors';

export default function NewItemPage() {
  const router = useRouter();
  const { activeCompany: company } = useCompany();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [form, setForm] = useState<FormState>({ ...BLANK });

  const loadCategories = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/item-categories', { credentials: 'include' });
      const json = await res.json();
      setCategories(json.data || []);
    } catch { setCategories([]); }
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/chart-of-accounts', { credentials: 'include' });
      const json = await res.json();
      setAccounts(json.data || []);
    } catch { setAccounts([]); }
  }, []);

  useEffect(() => { loadCategories(); loadAccounts(); }, [loadCategories, loadAccounts]);

  const update = (field: string, value: string | boolean) => {
    setForm(prev => {
      const next = { ...prev, [field]: value } as FormState;

      if (field === 'cost_price' || field === 'selling_price_excl') {
        const cost = Number(field === 'cost_price' ? value : next.cost_price) || 0;
        const excl = Number(field === 'selling_price_excl' ? value : next.selling_price_excl) || 0;
        if (excl > 0 && cost >= 0) next.gp_percent = (((excl - cost) / excl) * 100).toFixed(2);
      }
      if (field === 'selling_price_excl') {
        const excl = Number(value) || 0;
        const vatRate = next.vat_on_sales === 'standard' ? DEFAULT_VAT_RATE : 0;
        next.selling_price_incl = (excl * (1 + vatRate)).toFixed(2);
      }
      if (field === 'selling_price_incl') {
        const incl = Number(value) || 0;
        const vatRate = next.vat_on_sales === 'standard' ? DEFAULT_VAT_RATE : 0;
        const excl = vatRate > 0 ? incl / (1 + vatRate) : incl;
        next.selling_price_excl = excl.toFixed(2);
        const cost = Number(next.cost_price) || 0;
        if (excl > 0 && cost >= 0) next.gp_percent = (((excl - cost) / excl) * 100).toFixed(2);
      }
      if (field === 'vat_on_sales') {
        const excl = Number(next.selling_price_excl) || 0;
        const vatRate = value === 'standard' ? 0.15 : 0;
        next.selling_price_incl = (excl * (1 + vatRate)).toFixed(2);
      }
      return next;
    });
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(''); setSaving(true);
    try {
      const payload = {
        code: form.code || undefined,
        description: form.description,
        category_id: form.category_id || undefined,
        item_type: form.item_type,
        is_active: form.is_active,
        unit: form.unit,
        cost_price: Number(form.cost_price) || 0,
        selling_price_excl: Number(form.selling_price_excl) || 0,
        selling_price_incl: Number(form.selling_price_incl) || 0,
        gp_percent: Number(form.gp_percent) || 0,
        vat_on_sales: form.vat_on_sales,
        vat_on_purchases: form.vat_on_purchases,
        sales_account_id: form.sales_account_id || undefined,
        purchases_account_id: form.purchases_account_id || undefined,
        opening_qty: Number(form.opening_qty) || 0,
        opening_cost: Number(form.opening_cost) || 0,
        opening_date: form.opening_date || undefined,
        notes: form.notes || undefined,
      };
      const res = await apiFetch('/api/accounting/items', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error?.message || 'Failed to create item');
      router.push('/accounting/items');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create item');
    } finally { setSaving(false); }
  };

  const salesAccounts = accounts.filter(a =>
    String(a.account_number).startsWith('4') || String(a.name).toLowerCase().includes('sales')
  );
  const purchaseAccounts = accounts.filter(a =>
    String(a.account_number).startsWith('5') || String(a.name).toLowerCase().includes('purchase') || String(a.name).toLowerCase().includes('cost')
  );

  const gpNum = Number(form.gp_percent) || 0;

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        {/* Page header */}
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-7">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10">
            <Link href="/accounting/items" className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 mb-4 transition-colors">
              <ArrowLeft className="h-3.5 w-3.5" /> Back to Items
            </Link>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-amber-500/15 flex items-center justify-center">
                <Package className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-0.5">New Record</p>
                <h1 className="text-xl font-bold text-white">
                  New Item{company?.name ? ` — ${company.name}` : ''}
                </h1>
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

                {/* Section 1 — Item Details (sub-component provides its own card shell) */}
                <div className="space-y-0">
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold shrink-0">1</span>
                    <span className="text-sm font-semibold text-slate-900 dark:text-white">Item Details</span>
                  </div>
                  <ItemDetailsSection
                    code={form.code} description={form.description} category_id={form.category_id}
                    item_type={form.item_type} unit={form.unit} is_active={form.is_active}
                    categories={categories} onChange={update}
                  />
                </div>

                {/* Section 2 — Pricing */}
                <div className="space-y-0">
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold shrink-0">2</span>
                    <span className="text-sm font-semibold text-slate-900 dark:text-white">Pricing</span>
                  </div>
                  <PricingSection
                    cost_price={form.cost_price} selling_price_excl={form.selling_price_excl}
                    selling_price_incl={form.selling_price_incl} gp_percent={form.gp_percent}
                    onChange={update}
                  />
                </div>

                {/* Section 3 — VAT & Accounts */}
                <div className="space-y-0">
                  <div className="flex items-center gap-2 mb-2 px-1">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold shrink-0">3</span>
                    <span className="text-sm font-semibold text-slate-900 dark:text-white">VAT &amp; Accounts</span>
                  </div>
                  <VatAccountsSection
                    vat_on_sales={form.vat_on_sales} vat_on_purchases={form.vat_on_purchases}
                    sales_account_id={form.sales_account_id} purchases_account_id={form.purchases_account_id}
                    salesAccounts={salesAccounts} purchaseAccounts={purchaseAccounts}
                    onChange={update}
                  />
                </div>

                {/* Section 4 — Opening Balances (physical only) */}
                {form.item_type === 'physical' && (
                  <div className="space-y-0">
                    <div className="flex items-center gap-2 mb-2 px-1">
                      <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold shrink-0">4</span>
                      <span className="text-sm font-semibold text-slate-900 dark:text-white">Opening Balances</span>
                    </div>
                    <OpeningBalancesSection
                      opening_qty={form.opening_qty} opening_cost={form.opening_cost}
                      opening_date={form.opening_date} onChange={update}
                    />
                  </div>
                )}

                {/* Notes */}
                <div className={`${card} p-5`}>
                  <h3 className="text-sm font-semibold text-slate-900 dark:text-white mb-4 flex items-center gap-2">
                    <span className="w-5 h-5 rounded bg-amber-500/10 flex items-center justify-center text-amber-500 text-xs font-bold">
                      {form.item_type === 'physical' ? '5' : '4'}
                    </span>
                    Notes
                  </h3>
                  <textarea name="notes" value={form.notes}
                    onChange={e => update('notes', e.target.value)}
                    rows={3} placeholder="Additional notes about this item…"
                    className={`${inp} resize-none`} />
                </div>
              </div>

              {/* Right column — sticky summary */}
              <div className="w-72 shrink-0">
                <div className="sticky top-6">
                  <div className={`${card} p-5`}>
                    <div className="flex items-center gap-2 mb-5">
                      <Database className="w-4 h-4 text-amber-500" />
                      <h3 className="text-sm font-semibold text-slate-900 dark:text-white">Item Summary</h3>
                    </div>

                    <div className="space-y-3 mb-5">
                      {form.description && (
                        <div>
                          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Description</p>
                          <p className="text-sm text-slate-900 dark:text-slate-100 font-medium mt-0.5 truncate">{form.description}</p>
                        </div>
                      )}
                      <div className="flex justify-between text-sm">
                        <span className="text-slate-500 dark:text-slate-400">Type</span>
                        <span className="font-medium text-slate-900 dark:text-slate-100 capitalize">{form.item_type}</span>
                      </div>
                      {form.selling_price_excl && (
                        <>
                          <div className="h-px bg-slate-100 dark:bg-slate-800" />
                          <div className="flex justify-between text-sm">
                            <span className="text-slate-500 dark:text-slate-400">Price (excl)</span>
                            <span className="font-mono text-slate-900 dark:text-slate-100">
                              R {Number(form.selling_price_excl).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}
                            </span>
                          </div>
                          <div className="flex justify-between text-sm">
                            <span className="text-slate-500 dark:text-slate-400">Price (incl)</span>
                            <span className="font-mono text-slate-900 dark:text-slate-100">
                              R {Number(form.selling_price_incl || 0).toLocaleString('en-ZA', { minimumFractionDigits: 2 })}
                            </span>
                          </div>
                          {form.gp_percent && (
                            <>
                              <div className="h-px bg-slate-100 dark:bg-slate-800" />
                              <div className="flex justify-between">
                                <span className="text-sm font-semibold text-slate-900 dark:text-white">GP Margin</span>
                                <span className={`font-mono font-bold text-lg ${gpNum >= 30 ? 'text-emerald-500' : gpNum >= 15 ? 'text-amber-500' : 'text-red-500'}`}>
                                  {gpNum.toFixed(1)}%
                                </span>
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
                        : <><Package className="h-4 w-4" />Create Item</>}
                    </button>
                    <Link href="/accounting/items"
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
