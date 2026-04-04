/**
 * New Item Page — thin shell
 * Route: /accounting/items/new
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Package, Save, ArrowLeft, Loader2 } from 'lucide-react';
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

  const handleSubmit = async (e: React.FormEvent) => {
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

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <Link href="/accounting/items" className="p-2 rounded-lg hover:bg-[var(--ff-bg-primary)]">
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-blue-500/10"><Package className="h-6 w-6 text-blue-500" /></div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Item</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Add a new inventory or service item{company?.name ? ` for ${company.name}` : ''}
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 max-w-3xl space-y-6">
          {error && <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>}

          <ItemDetailsSection
            code={form.code} description={form.description} category_id={form.category_id}
            item_type={form.item_type} unit={form.unit} is_active={form.is_active}
            categories={categories} onChange={update}
          />

          <PricingSection
            cost_price={form.cost_price} selling_price_excl={form.selling_price_excl}
            selling_price_incl={form.selling_price_incl} gp_percent={form.gp_percent}
            onChange={update}
          />

          <VatAccountsSection
            vat_on_sales={form.vat_on_sales} vat_on_purchases={form.vat_on_purchases}
            sales_account_id={form.sales_account_id} purchases_account_id={form.purchases_account_id}
            salesAccounts={salesAccounts} purchaseAccounts={purchaseAccounts}
            onChange={update}
          />

          {form.item_type === 'physical' && (
            <OpeningBalancesSection
              opening_qty={form.opening_qty} opening_cost={form.opening_cost}
              opening_date={form.opening_date} onChange={update}
            />
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Notes</h2>
            <textarea value={form.notes} onChange={e => update('notes', e.target.value)}
              className="ff-input w-full" rows={3} placeholder="Additional notes about this item..." />
          </div>

          <div className="flex justify-end gap-3">
            <Link href="/accounting/items" className="px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] text-sm">
              Cancel
            </Link>
            <button type="submit" disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50">
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save Item
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
