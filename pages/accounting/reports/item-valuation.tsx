/**
 * Item Valuation Report
 * Sage Parity: Items > Reports > Item Valuation
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { DollarSign, Loader2, Download } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface Row { id: string; itemCode: string; name: string; category: string; uom: string; qtyOnHand: number; costPrice: number; stockValue: number; }

export default function ItemValuationReport() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/reports/item-valuation', { credentials: 'include' });
      const json = await res.json();
      setRows(json.data || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const totalValue = rows.reduce((s, r) => s + r.stockValue, 0);

  // Group by category for summary
  const byCategory = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.category] = (acc[r.category] || 0) + r.stockValue;
    return acc;
  }, {});

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-amber-500/10"><DollarSign className="h-6 w-6 text-amber-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Item Valuation</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Current stock value by item</p>
              </div>
            </div>
            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="text-xs text-[var(--ff-text-tertiary)]">Total Stock Value</p>
                <p className="text-xl font-bold text-amber-400 font-mono">{fmt(totalValue)}</p>
              </div>
              <button onClick={() => window.open('/api/accounting/reports/item-valuation?format=csv', '_blank')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg">
                <Download className="h-4 w-4" /> CSV
              </button>
            </div>
          </div>
        </div>
        <div className="p-6 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}
          {/* Category summary */}
          {!loading && Object.keys(byCategory).length > 1 && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([cat, val]) => (
                <div key={cat} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-3">
                  <p className="text-xs text-[var(--ff-text-tertiary)] truncate">{cat}</p>
                  <p className="text-sm font-bold text-[var(--ff-text-primary)] font-mono">{fmt(val)}</p>
                </div>
              ))}
            </div>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {loading ? (
              <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" /></div>
            ) : rows.length === 0 ? (
              <div className="p-8 text-center text-[var(--ff-text-tertiary)]">No items with stock value</div>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Code</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Item</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Category</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">UOM</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Qty</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Unit Cost</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Value</th>
                </tr></thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {rows.map(r => (
                    <tr key={r.id} className="hover:bg-[var(--ff-bg-tertiary)]">
                      <td className="px-4 py-3 font-mono text-xs text-[var(--ff-text-tertiary)]">{r.itemCode}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-primary)]">{r.name}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{r.category}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-tertiary)]">{r.uom}</td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{r.qtyOnHand}</td>
                      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-secondary)]">{fmt(r.costPrice)}</td>
                      <td className="px-4 py-3 text-right font-mono text-amber-400 font-medium">{fmt(r.stockValue)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="border-t-2 border-[var(--ff-border-medium)] bg-[var(--ff-bg-tertiary)] font-bold">
                  <td className="px-4 py-3" colSpan={6}>TOTAL STOCK VALUE</td>
                  <td className="px-4 py-3 text-right font-mono text-amber-400">{fmt(totalValue)}</td>
                </tr></tfoot>
              </table>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
