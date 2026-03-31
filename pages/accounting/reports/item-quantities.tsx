/**
 * Item Quantities Report
 * Sage Parity: Items > Reports > Item Quantities
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Package, Loader2, Download, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface Row { id: string; itemCode: string; name: string; category: string; uom: string; qtyOnHand: number; minLevel: number; lowStock: boolean; }

export default function ItemQuantitiesReport() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showLowOnly, setShowLowOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = showLowOnly ? '?low_stock=true' : '';
      const res = await apiFetch(`/api/accounting/reports/item-quantities${params}`, { credentials: 'include' });
      const json = await res.json();
      setRows(json.data || []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [showLowOnly]);

  useEffect(() => { load(); }, [load]);

  const lowCount = rows.filter(r => r.lowStock).length;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-sky-500/10"><Package className="h-6 w-6 text-sky-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Item Quantities</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">On-hand quantities with low stock alerts</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)] cursor-pointer">
                <input type="checkbox" checked={showLowOnly} onChange={e => setShowLowOnly(e.target.checked)}
                  className="rounded border-[var(--ff-border-light)]" />
                Low stock only
              </label>
              <button onClick={() => window.open(`/api/accounting/reports/item-quantities?format=csv${showLowOnly ? '&low_stock=true' : ''}`, '_blank')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg">
                <Download className="h-4 w-4" /> CSV
              </button>
            </div>
          </div>
        </div>
        <div className="p-6 space-y-4">
          {error && <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded">{error}</div>}
          {!loading && lowCount > 0 && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 text-amber-400 text-sm">
              <AlertTriangle className="h-4 w-4" /> {lowCount} item(s) at or below minimum stock level
            </div>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {loading ? (
              <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" /></div>
            ) : rows.length === 0 ? (
              <div className="p-8 text-center text-[var(--ff-text-tertiary)]">{showLowOnly ? 'No low stock items' : 'No items found'}</div>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Code</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Item</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Category</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">UOM</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">On Hand</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Min Level</th>
                  <th className="px-4 py-3 text-center text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Status</th>
                </tr></thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {rows.map(r => (
                    <tr key={r.id} className={`hover:bg-[var(--ff-bg-tertiary)] ${r.lowStock ? 'bg-red-500/5' : ''}`}>
                      <td className="px-4 py-3 font-mono text-xs text-[var(--ff-text-tertiary)]">{r.itemCode}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-primary)]">{r.name}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{r.category}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-tertiary)]">{r.uom}</td>
                      <td className={`px-4 py-3 text-right font-mono ${r.lowStock ? 'text-red-400 font-bold' : 'text-[var(--ff-text-primary)]'}`}>{r.qtyOnHand}</td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)]">{r.minLevel > 0 ? r.minLevel : '—'}</td>
                      <td className="px-4 py-3 text-center">
                        {r.lowStock ? (
                          <span className="px-2 py-0.5 rounded text-xs font-medium bg-red-500/10 text-red-400">Low</span>
                        ) : (
                          <span className="px-2 py-0.5 rounded text-xs font-medium bg-teal-500/10 text-teal-400">OK</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
}
