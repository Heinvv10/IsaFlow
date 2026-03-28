/**
 * Stock Levels Dashboard
 * Route: /accounting/stock-levels
 */
import { useState, useEffect } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { BarChart3, Loader2, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';

interface StockItem { id: string; code: string; name: string; current_stock: number; reorder_level: number; avg_cost: number; selling_price: number; unit: string; category: string; stock_value: number; }
interface Summary { totalProducts: number; totalStockValue: number; belowReorder: number; }
const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export default function StockLevelsPage() {
  const [items, setItems] = useState<StockItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [showBelowOnly, setShowBelowOnly] = useState(false);

  useEffect(() => {
    const params = showBelowOnly ? '?belowReorder=true' : '';
    apiFetch(`/api/accounting/stock-levels${params}`, { credentials: 'include' })
      .then(r => r.json()).then(j => { setItems(j.data?.items || []); setSummary(j.data?.summary || null); setLoading(false); })
      .catch(() => setLoading(false));
  }, [showBelowOnly]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-green-500/10"><BarChart3 className="h-6 w-6 text-green-500" /></div>
              <div><h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Stock Levels</h1><p className="text-sm text-[var(--ff-text-secondary)]">Current inventory quantities and valuations</p></div>
            </div>
            <ExportCSVButton endpoint="/api/accounting/stock-levels?format=csv" filenamePrefix="stock-levels" label="Export CSV" />
          </div>
        </div>
        <div className="p-6 space-y-4">
          {summary && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)]">Total Inventory Items</p>
                <p className="text-xl font-bold text-[var(--ff-text-primary)]">{summary.totalProducts}</p>
              </div>
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)]">Total Stock Value</p>
                <p className="text-xl font-bold text-teal-400">{fmt(summary.totalStockValue)}</p>
              </div>
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)]">Below Reorder Level</p>
                <p className={`text-xl font-bold ${summary.belowReorder > 0 ? 'text-amber-400' : 'text-teal-400'}`}>{summary.belowReorder}</p>
              </div>
            </div>
          )}
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
              <input type="checkbox" checked={showBelowOnly} onChange={e => setShowBelowOnly(e.target.checked)} className="rounded" />
              Show only below reorder level
            </label>
          </div>
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-3">Code</th><th className="px-4 py-3">Product</th><th className="px-4 py-3">Category</th>
                <th className="px-4 py-3 text-right">In Stock</th><th className="px-4 py-3 text-right">Reorder At</th>
                <th className="px-4 py-3 text-right">Avg Cost</th><th className="px-4 py-3 text-right">Stock Value</th>
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]"><Loader2 className="h-5 w-5 animate-spin inline mr-2" />Loading...</td></tr>}
                {!loading && items.length === 0 && <tr><td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">No inventory items</td></tr>}
                {items.map(i => {
                  const below = Number(i.current_stock) <= Number(i.reorder_level) && Number(i.reorder_level) > 0;
                  return (
                    <tr key={i.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                      <td className="px-4 py-3 font-medium text-[var(--ff-text-primary)]">{i.code}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{i.name}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{i.category}</td>
                      <td className={`px-4 py-3 text-right font-medium ${below ? 'text-amber-400' : 'text-[var(--ff-text-primary)]'}`}>
                        {below && <AlertTriangle className="h-3 w-3 inline mr-1" />}{Number(i.current_stock)} {i.unit}
                      </td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)]">{Number(i.reorder_level)}</td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(Number(i.avg_cost))}</td>
                      <td className="px-4 py-3 text-right text-teal-400">{fmt(Number(i.stock_value || 0))}</td>
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
