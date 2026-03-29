/**
 * New Item Page
 * Route: /accounting/items/new
 */
import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Package, Save, ArrowLeft, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { apiFetch } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';

interface Category {
  id: string;
  name: string;
}

interface Account {
  id: string;
  account_number: string;
  name: string;
}

const VAT_OPTIONS = [
  { value: 'standard', label: 'Standard (15%)' },
  { value: 'zero', label: 'Zero Rated (0%)' },
  { value: 'exempt', label: 'Exempt' },
];

export default function NewItemPage() {
  const router = useRouter();
  const { activeCompany: company } = useCompany();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);

  const [form, setForm] = useState({
    code: '',
    description: '',
    category_id: '',
    item_type: 'physical' as 'physical' | 'service',
    is_active: true,
    unit: 'each',
    cost_price: '',
    selling_price_excl: '',
    selling_price_incl: '',
    gp_percent: '',
    vat_on_sales: 'standard',
    vat_on_purchases: 'standard',
    sales_account_id: '',
    purchases_account_id: '',
    opening_qty: '',
    opening_cost: '',
    opening_date: '',
    notes: '',
  });

  const loadCategories = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/item-categories', { credentials: 'include' });
      const json = await res.json();
      setCategories(json.data || []);
    } catch {
      setCategories([]);
    }
  }, []);

  const loadAccounts = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/chart-of-accounts', { credentials: 'include' });
      const json = await res.json();
      setAccounts(json.data || []);
    } catch {
      setAccounts([]);
    }
  }, []);

  useEffect(() => {
    loadCategories();
    loadAccounts();
  }, [loadCategories, loadAccounts]);

  const update = (field: string, value: string | boolean) => {
    setForm(prev => {
      const next = { ...prev, [field]: value };

      // Auto-calculate GP% when cost and excl selling price change
      if (field === 'cost_price' || field === 'selling_price_excl') {
        const cost = Number(field === 'cost_price' ? value : next.cost_price) || 0;
        const excl = Number(field === 'selling_price_excl' ? value : next.selling_price_excl) || 0;
        if (excl > 0 && cost >= 0) {
          next.gp_percent = (((excl - cost) / excl) * 100).toFixed(2);
        }
      }

      // Auto-calculate inclusive price from exclusive (VAT 15%)
      if (field === 'selling_price_excl') {
        const excl = Number(value) || 0;
        const vatRate = next.vat_on_sales === 'standard' ? 0.15 : 0;
        next.selling_price_incl = (excl * (1 + vatRate)).toFixed(2);
      }

      // Auto-calculate exclusive price from inclusive
      if (field === 'selling_price_incl') {
        const incl = Number(value) || 0;
        const vatRate = next.vat_on_sales === 'standard' ? 0.15 : 0;
        const excl = vatRate > 0 ? incl / (1 + vatRate) : incl;
        next.selling_price_excl = excl.toFixed(2);
        const cost = Number(next.cost_price) || 0;
        if (excl > 0 && cost >= 0) {
          next.gp_percent = (((excl - cost) / excl) * 100).toFixed(2);
        }
      }

      // Recalculate inclusive when VAT type changes
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
    setError('');
    setSaving(true);
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
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error?.message || 'Failed to create item');
      }
      router.push('/accounting/items');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create item');
    } finally {
      setSaving(false);
    }
  };

  const salesAccounts = accounts.filter(
    a => String(a.account_number).startsWith('4') || String(a.name).toLowerCase().includes('sales')
  );
  const purchaseAccounts = accounts.filter(
    a => String(a.account_number).startsWith('5') || String(a.name).toLowerCase().includes('purchase') || String(a.name).toLowerCase().includes('cost')
  );

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <Link
              href="/accounting/items"
              className="p-2 rounded-lg hover:bg-[var(--ff-bg-primary)]"
            >
              <ArrowLeft className="h-5 w-5 text-[var(--ff-text-secondary)]" />
            </Link>
            <div className="p-2 rounded-lg bg-blue-500/10">
              <Package className="h-6 w-6 text-blue-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">New Item</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Add a new inventory or service item
                {company?.name ? ` for ${company.name}` : ''}
              </p>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="p-6 max-w-3xl space-y-6">
          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>
          )}

          {/* Item Details */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Item Details</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">
                  Code <span className="text-[var(--ff-text-tertiary)]">(auto-generated if blank)</span>
                </label>
                <input
                  type="text"
                  value={form.code}
                  onChange={e => update('code', e.target.value)}
                  className="ff-input w-full"
                  placeholder="ITEM-0001"
                />
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">
                  Description *
                </label>
                <input
                  type="text"
                  required
                  value={form.description}
                  onChange={e => update('description', e.target.value)}
                  className="ff-input w-full"
                />
              </div>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Category</label>
                <select
                  value={form.category_id}
                  onChange={e => update('category_id', e.target.value)}
                  className="ff-select w-full"
                >
                  <option value="">No category</option>
                  {categories.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">
                  Item Type *
                </label>
                <div className="flex gap-4 mt-2">
                  <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)] cursor-pointer">
                    <input
                      type="radio"
                      name="item_type"
                      value="physical"
                      checked={form.item_type === 'physical'}
                      onChange={e => update('item_type', e.target.value)}
                      className="accent-teal-500"
                    />
                    Physical
                  </label>
                  <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)] cursor-pointer">
                    <input
                      type="radio"
                      name="item_type"
                      value="service"
                      checked={form.item_type === 'service'}
                      onChange={e => update('item_type', e.target.value)}
                      className="accent-teal-500"
                    />
                    Service
                  </label>
                </div>
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Unit</label>
                <input
                  type="text"
                  value={form.unit}
                  onChange={e => update('unit', e.target.value)}
                  className="ff-input w-full"
                  placeholder="each"
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-primary)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={e => update('is_active', e.target.checked)}
                  className="accent-teal-500 h-4 w-4"
                />
                Active
              </label>
            </div>
          </div>

          {/* Pricing */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Pricing</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">Cost Price (ZAR)</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.cost_price}
                  onChange={e => update('cost_price', e.target.value)}
                  className="ff-input w-full"
                />
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">
                  Exclusive Selling Price (ZAR)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.selling_price_excl}
                  onChange={e => update('selling_price_excl', e.target.value)}
                  className="ff-input w-full"
                />
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">
                  Inclusive Selling Price (ZAR)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.selling_price_incl}
                  onChange={e => update('selling_price_incl', e.target.value)}
                  className="ff-input w-full"
                />
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">GP %</label>
                <input
                  type="number"
                  step="0.01"
                  value={form.gp_percent}
                  onChange={e => update('gp_percent', e.target.value)}
                  className="ff-input w-full"
                  readOnly
                />
              </div>
            </div>
          </div>

          {/* VAT & Accounts */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">VAT & Accounts</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">
                  VAT on Sales
                </label>
                <select
                  value={form.vat_on_sales}
                  onChange={e => update('vat_on_sales', e.target.value)}
                  className="ff-select w-full"
                >
                  {VAT_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">
                  VAT on Purchases
                </label>
                <select
                  value={form.vat_on_purchases}
                  onChange={e => update('vat_on_purchases', e.target.value)}
                  className="ff-select w-full"
                >
                  {VAT_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">
                  Sales Account
                </label>
                <select
                  value={form.sales_account_id}
                  onChange={e => update('sales_account_id', e.target.value)}
                  className="ff-select w-full"
                >
                  <option value="">Select account...</option>
                  {salesAccounts.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.account_number} - {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">
                  Purchases Account
                </label>
                <select
                  value={form.purchases_account_id}
                  onChange={e => update('purchases_account_id', e.target.value)}
                  className="ff-select w-full"
                >
                  <option value="">Select account...</option>
                  {purchaseAccounts.map(a => (
                    <option key={a.id} value={a.id}>
                      {a.account_number} - {a.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Opening Balances (physical items only) */}
          {form.item_type === 'physical' && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">
                Opening Balances
              </h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">
                    Opening Qty
                  </label>
                  <input
                    type="number"
                    step="1"
                    min="0"
                    value={form.opening_qty}
                    onChange={e => update('opening_qty', e.target.value)}
                    className="ff-input w-full"
                  />
                </div>
                <div>
                  <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">
                    Opening Cost (ZAR)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.opening_cost}
                    onChange={e => update('opening_cost', e.target.value)}
                    className="ff-input w-full"
                  />
                </div>
                <div>
                  <label className="block text-sm text-[var(--ff-text-secondary)] mb-1">
                    Opening Date
                  </label>
                  <input
                    type="date"
                    value={form.opening_date}
                    onChange={e => update('opening_date', e.target.value)}
                    className="ff-input w-full"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Notes */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5 space-y-4">
            <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Notes</h2>
            <textarea
              value={form.notes}
              onChange={e => update('notes', e.target.value)}
              className="ff-input w-full"
              rows={3}
              placeholder="Additional notes about this item..."
            />
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-3">
            <Link
              href="/accounting/items"
              className="px-4 py-2 rounded-lg border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] text-sm"
            >
              Cancel
            </Link>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}{' '}
              Save Item
            </button>
          </div>
        </form>
      </div>
    </AppLayout>
  );
}
