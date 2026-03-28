/**
 * Items List Page
 * Route: /accounting/items
 */
import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Package, Plus, Search, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { apiFetch } from '@/lib/apiFetch';
import { useCompany } from '@/contexts/CompanyContext';

interface ItemCategory {
  id: string;
  name: string;
}

interface Item {
  id: string;
  code: string;
  description: string;
  item_type: 'physical' | 'service';
  category_id: string | null;
  category_name: string | null;
  selling_price_excl: number;
  cost_price: number;
  current_qty: number;
  is_active: boolean;
  unit: string;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export default function ItemsListPage() {
  const { activeCompany: company } = useCompany();
  const [items, setItems] = useState<Item[]>([]);
  const [categories, setCategories] = useState<ItemCategory[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('q', search);
      if (typeFilter) params.set('type', typeFilter);
      if (categoryFilter) params.set('category_id', categoryFilter);
      params.set('active', 'true');
      const res = await apiFetch(`/api/accounting/items?${params}`, { credentials: 'include' });
      const json = await res.json();
      setItems(json.data || []);
    } catch {
      setItems([]);
    }
    setLoading(false);
  }, [search, typeFilter, categoryFilter]);

  const loadCategories = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/item-categories', { credentials: 'include' });
      const json = await res.json();
      setCategories(json.data || []);
    } catch {
      setCategories([]);
    }
  }, []);

  useEffect(() => {
    loadCategories();
  }, [loadCategories]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const physicalCount = items.filter(i => i.item_type === 'physical').length;
  const serviceCount = items.filter(i => i.item_type === 'service').length;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10">
                <Package className="h-6 w-6 text-blue-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Items</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Manage inventory and service items
                  {company?.name ? ` for ${company.name}` : ''}
                </p>
              </div>
            </div>
            <Link
              href="/accounting/items/new"
              className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium"
            >
              <Plus className="h-4 w-4" /> Add Item
            </Link>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Total Items</p>
              <p className="text-xl font-bold text-[var(--ff-text-primary)]">{items.length}</p>
            </div>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Physical</p>
              <p className="text-xl font-bold text-blue-400">{physicalCount}</p>
            </div>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Service</p>
              <p className="text-xl font-bold text-purple-400">{serviceCount}</p>
            </div>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input
                type="text"
                placeholder="Search items..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="ff-input pl-9 text-sm w-64"
              />
            </div>
            <select
              value={typeFilter}
              onChange={e => setTypeFilter(e.target.value)}
              className="ff-select text-sm"
            >
              <option value="">All Types</option>
              <option value="physical">Physical</option>
              <option value="service">Service</option>
            </select>
            {categories.length > 0 && (
              <select
                value={categoryFilter}
                onChange={e => setCategoryFilter(e.target.value)}
                className="ff-select text-sm"
              >
                <option value="">All Categories</option>
                {categories.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
          </div>

          {/* Table */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Description</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3 text-right">Selling Price</th>
                  <th className="px-4 py-3 text-right">Cost Price</th>
                  <th className="px-4 py-3 text-right">Qty on Hand</th>
                  <th className="px-4 py-3 text-center">Active</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Loading...
                    </td>
                  </tr>
                )}
                {!loading && items.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      No items found.{' '}
                      <Link href="/accounting/items/new" className="text-teal-400 hover:underline">
                        Add your first item
                      </Link>
                    </td>
                  </tr>
                )}
                {items.map(item => (
                  <tr
                    key={item.id}
                    className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50"
                  >
                    <td className="px-4 py-3 font-medium text-[var(--ff-text-primary)]">
                      <Link
                        href={`/accounting/items/${item.id}`}
                        className="hover:text-teal-400"
                      >
                        {item.code}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                      {item.description}
                    </td>
                    <td className="px-4 py-3">
                      {item.item_type === 'physical' ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-blue-500/10 text-blue-400">
                          Physical
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-purple-500/10 text-purple-400">
                          Service
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">
                      {item.category_name || '-'}
                    </td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">
                      {fmt(Number(item.selling_price_excl))}
                    </td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">
                      {fmt(Number(item.cost_price))}
                    </td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">
                      {item.item_type === 'physical'
                        ? `${Number(item.current_qty)} ${item.unit || ''}`
                        : '-'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {item.is_active ? (
                        <span className="inline-block h-2 w-2 rounded-full bg-green-500" title="Active" />
                      ) : (
                        <span className="inline-block h-2 w-2 rounded-full bg-gray-500" title="Inactive" />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
