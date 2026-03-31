/**
 * Sales by Item Report
 * Sage Parity: Items > Reports > Sales by Item
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { TrendingUp, Loader2, Download } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface Row { id: string; itemCode: string; name: string; category: string; timesSold: number; qtySold: number; totalRevenue: number; avgPrice: number; }

export default function SalesByItemReport() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const today = new Date();
  const [from, setFrom] = useState(new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0]);
  const [to, setTo] = useState(today.toISOString().split('T')[0]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/reports/sales-by-item?from=${from}&to=${to}`, { credentials: 'include' });
      const json = await res.json();
      setRows(json.data || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => { load(); }, [load]);

  const totals = rows.reduce((a, r) => ({
    qtySold: a.qtySold + r.qtySold, totalRevenue: a.totalRevenue + r.totalRevenue,
  }), { qtySold: 0, totalRevenue: 0 });

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10"><TrendingUp className="h-6 w-6 text-teal-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Sales by Item</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Revenue breakdown per stock item</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <input type="date" value={from} onChange={e => setFrom(e.target.value)} className="ff-input text-sm" />
              <span className="text-[var(--ff-text-tertiary)]">to</span>
              <input type="date" value={to} onChange={e => setTo(e.target.value)} className="ff-input text-sm" />
              <button onClick={() => window.open(`/api/accounting/reports/sales-by-item?from=${from}&to=${to}&format=csv`, '_blank')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg">
                <Download className="h-4 w-4" /> CSV
              </button>
            </div>
          </div>
        </div>
        <div className="p-6">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-4">{error}</div>}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {loading ? (
              <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" /></div>
            ) : rows.length === 0 ? (
              <div className="p-8 text-center text-[var(--ff-text-tertiary)]">No sales data for this period</div>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Code</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Item</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Category</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Times Sold</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Qty Sold</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Revenue</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Avg Price</th>
                </tr></thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {rows.map(r => (
                    <tr key={r.id} className="hover:bg-[var(--ff-bg-tertiary)]">
                      <td className="px-4 py-3 font-mono text-xs text-[var(--ff-text-tertiary)]">{r.itemCode}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">{r.name}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{r.category}</td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)]">{r.timesSold}</td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{r.qtySold}</td>
                      <td className="px-4 py-3 text-right font-mono text-teal-400">{fmt(r.totalRevenue)}</td>
                      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-secondary)]">{fmt(r.avgPrice)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr className="border-t-2 border-[var(--ff-border-medium)] bg-[var(--ff-bg-tertiary)] font-bold">
                  <td className="px-4 py-3" colSpan={4}>TOTAL</td>
                  <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{totals.qtySold}</td>
                  <td className="px-4 py-3 text-right font-mono text-teal-400">{fmt(totals.totalRevenue)}</td>
                  <td className="px-4 py-3"></td>
                </tr></tfoot>
              </table>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
