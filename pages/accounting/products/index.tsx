/**
 * Products List Page — Inventory Items
 * Route: /accounting/products
 */
import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Box, Loader2, Plus, Search, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { apiFetch } from '@/lib/apiFetch';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';

interface Product {
  id: string; code: string; name: string; category: string; category_name: string;
  product_type: string; unit: string; cost_price: number; selling_price: number;
  current_stock: number; reorder_level: number; avg_cost: number; is_active: boolean;
}
const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export default function ProductsListPage() {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (typeFilter) params.set('type', typeFilter);
      const res = await apiFetch(`/api/accounting/products?${params}`, { credentials: 'include' });
      const json = await res.json();
      setProducts(json.data || []);
    } catch { setProducts([]); }
    setLoading(false);
  }, [search, typeFilter]);

  useEffect(() => { load(); }, [load]);

  const totalValue = products.reduce((s, p) => s + Number(p.current_stock || 0) * Number(p.avg_cost || p.cost_price || 0), 0);
  const belowReorder = products.filter(p => p.product_type === 'inventory' && Number(p.current_stock) <= Number(p.reorder_level) && Number(p.reorder_level) > 0);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-500/10"><Box className="h-6 w-6 text-blue-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Products & Inventory</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Manage products, stock levels, and valuations</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ExportCSVButton endpoint="/api/accounting/products?format=csv" filenamePrefix="products" label="Export CSV" />
              <Link href="/accounting/products/new" className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium">
                <Plus className="h-4 w-4" /> Add Product
              </Link>
            </div>
          </div>
        </div>
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Total Products</p>
              <p className="text-xl font-bold text-[var(--ff-text-primary)]">{products.length}</p>
            </div>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Stock Value</p>
              <p className="text-xl font-bold text-teal-400">{fmt(totalValue)}</p>
            </div>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Below Reorder</p>
              <p className="text-xl font-bold text-amber-400">{belowReorder.length}</p>
            </div>
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <p className="text-xs text-[var(--ff-text-tertiary)]">Inventory Items</p>
              <p className="text-xl font-bold text-[var(--ff-text-primary)]">{products.filter(p => p.product_type === 'inventory').length}</p>
            </div>
          </div>
          {belowReorder.length > 0 && (
            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 flex items-center gap-2 text-sm text-amber-400">
              <AlertTriangle className="h-4 w-4" />{belowReorder.length} product(s) below reorder level
            </div>
          )}
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input type="text" placeholder="Search products..." value={search} onChange={e => setSearch(e.target.value)} className="ff-input pl-9 text-sm w-64" />
            </div>
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="ff-select text-sm">
              <option value="">All Types</option>
              <option value="inventory">Inventory</option>
              <option value="non_inventory">Non-Inventory</option>
              <option value="service">Service</option>
            </select>
          </div>
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                  <th className="px-4 py-3">Code</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3 text-right">Cost</th>
                  <th className="px-4 py-3 text-right">Selling</th>
                  <th className="px-4 py-3 text-right">Stock</th>
                  <th className="px-4 py-3 text-right">Value</th>
                </tr>
              </thead>
              <tbody>
                {loading && <tr><td colSpan={8} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]"><Loader2 className="h-5 w-5 animate-spin inline mr-2" />Loading...</td></tr>}
                {!loading && products.length === 0 && <tr><td colSpan={8} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No products yet. <Link href="/accounting/products/new" className="text-teal-400 hover:underline">Add your first product</Link></td></tr>}
                {products.map(p => {
                  const stock = Number(p.current_stock || 0);
                  const cost = Number(p.avg_cost || p.cost_price || 0);
                  const belowReorder = p.product_type === 'inventory' && stock <= Number(p.reorder_level) && Number(p.reorder_level) > 0;
                  return (
                    <tr key={p.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                      <td className="px-4 py-3 font-medium text-[var(--ff-text-primary)]"><Link href={`/accounting/products/${p.id}`} className="hover:text-teal-400">{p.code}</Link></td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{p.name}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{p.category_name || p.category}</td>
                      <td className="px-4 py-3 text-xs capitalize text-[var(--ff-text-secondary)]">{(p.product_type || '').replace(/_/g, ' ')}</td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(Number(p.cost_price))}</td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(Number(p.selling_price))}</td>
                      <td className={`px-4 py-3 text-right font-medium ${belowReorder ? 'text-amber-400' : 'text-[var(--ff-text-primary)]'}`}>{stock} {p.unit}</td>
                      <td className="px-4 py-3 text-right text-teal-400">{fmt(stock * cost)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
