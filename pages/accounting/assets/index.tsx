/**
 * Fixed Assets List Page
 * Displays all assets with filters for status and category.
 * Route: /accounting/assets
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Package, Loader2, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { apiFetch } from '@/lib/apiFetch';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';

interface Asset {
  id: string;
  asset_number: string;
  name: string;
  category: string;
  category_name: string;
  purchase_date: string;
  purchase_price: number;
  current_book_value: number;
  accumulated_depreciation: number;
  useful_life_years: number;
  depreciation_method: string;
  status: string;
  location: string;
  sars_rate: number;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

const statusColors: Record<string, string> = {
  available: 'bg-teal-500/10 text-teal-400',
  assigned: 'bg-blue-500/10 text-blue-400',
  in_maintenance: 'bg-amber-500/10 text-amber-400',
  disposed: 'bg-red-500/10 text-red-400',
  written_off: 'bg-gray-500/10 text-gray-400',
};

export default function AssetsListPage() {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  const loadAssets = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (categoryFilter) params.set('category', categoryFilter);
      if (search) params.set('search', search);
      const res = await apiFetch(`/api/accounting/assets?${params}`, { credentials: 'include' });
      const json = await res.json();
      setAssets(json.data || []);
    } catch {
      setAssets([]);
    }
    setLoading(false);
  }, [statusFilter, categoryFilter, search]);

  useEffect(() => { loadAssets(); }, [loadAssets]);

  const categories = [...new Set(assets.map(a => a.category_name || a.category || 'Uncategorized'))].sort();

  const summary = {
    totalCost: assets.reduce((s, a) => s + Number(a.purchase_price || 0), 0),
    totalBookValue: assets.reduce((s, a) => s + Number(a.current_book_value || a.purchase_price || 0), 0),
    totalDepreciation: assets.reduce((s, a) => s + Number(a.accumulated_depreciation || 0), 0),
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/10">
                <Package className="h-6 w-6 text-purple-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Fixed Assets</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Asset register with SARS wear-and-tear depreciation
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ExportCSVButton endpoint="/api/accounting/assets?format=csv" filenamePrefix="assets" label="Export CSV" />
              <Link
                href="/accounting/assets/new"
                className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium"
              >
                <Plus className="h-4 w-4" />
                Add Asset
              </Link>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Total Assets</p>
              <p className="text-xl font-bold text-[var(--ff-text-primary)]">{assets.length}</p>
            </div>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Total Cost</p>
              <p className="text-xl font-bold text-[var(--ff-text-primary)]">{fmt(summary.totalCost)}</p>
            </div>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Total Book Value</p>
              <p className="text-xl font-bold text-teal-400">{fmt(summary.totalBookValue)}</p>
            </div>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Total Depreciation</p>
              <p className="text-xl font-bold text-purple-400">{fmt(summary.totalDepreciation)}</p>
            </div>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input
                type="text"
                placeholder="Search assets..."
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="ff-input pl-9 text-sm w-64"
              />
            </div>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="ff-select text-sm">
              <option value="">All Status</option>
              <option value="available">Available</option>
              <option value="assigned">Assigned</option>
              <option value="in_maintenance">In Maintenance</option>
              <option value="disposed">Disposed</option>
              <option value="written_off">Written Off</option>
            </select>
            <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} className="ff-select text-sm">
              <option value="">All Categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <span className="text-sm text-[var(--ff-text-secondary)]">{assets.length} assets</span>
          </div>

          {/* Table */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                  <th className="px-4 py-3">Asset</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3 text-right">Cost</th>
                  <th className="px-4 py-3 text-right">Book Value</th>
                  <th className="px-4 py-3">Method</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Loading...
                    </td>
                  </tr>
                )}
                {!loading && assets.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      No assets found. <Link href="/accounting/assets/new" className="text-teal-400 hover:underline">Add your first asset</Link>
                    </td>
                  </tr>
                )}
                {assets.map(a => (
                  <tr key={a.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                    <td className="px-4 py-3 font-medium text-[var(--ff-text-primary)]">
                      <Link href={`/accounting/assets/${a.id}`} className="hover:text-teal-400">
                        {a.asset_number}
                      </Link>
                    </td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)] truncate max-w-[200px]">{a.name}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{a.category_name || a.category}</td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(Number(a.purchase_price))}</td>
                    <td className="px-4 py-3 text-right text-teal-400">{fmt(Number(a.current_book_value || a.purchase_price))}</td>
                    <td className="px-4 py-3 text-[var(--ff-text-secondary)] text-xs capitalize">{(a.depreciation_method || '').replace(/_/g, ' ')}</td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${statusColors[a.status] || ''}`}>
                        {(a.status || '').replace(/_/g, ' ')}
                      </span>
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
