/**
 * Item Listing Report
 * Sage Parity: Items > Reports > Item Listing
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { List, Loader2, Download, Search } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

interface Row { id: string; itemCode: string; name: string; description: string; category: string; uom: string; sellingPrice: number; costPrice: number; qtyOnHand: number; isActive: boolean; }

export default function ItemListingReport() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const params = search ? `?search=${encodeURIComponent(search)}` : '';
    const res = await apiFetch(`/api/accounting/reports/item-listing${params}`, { credentials: 'include' });
    const json = await res.json();
    setRows(json.data || []);
    setLoading(false);
  }, [search]);

  useEffect(() => { load(); }, [load]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/10"><List className="h-6 w-6 text-indigo-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Item Listing</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Master list of all stock items</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search..." className="ff-input pl-9 text-sm" />
              </div>
              <button onClick={() => window.open(`/api/accounting/reports/item-listing?format=csv${search ? `&search=${encodeURIComponent(search)}` : ''}`, '_blank')}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg">
                <Download className="h-4 w-4" /> CSV
              </button>
            </div>
          </div>
        </div>
        <div className="p-6">
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {loading ? (
              <div className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" /></div>
            ) : rows.length === 0 ? (
              <div className="p-8 text-center text-[var(--ff-text-tertiary)]">No items found</div>
            ) : (
              <table className="w-full text-sm">
                <thead><tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Code</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Name</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Category</th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">UOM</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Selling</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Cost</th>
                  <th className="px-4 py-3 text-right text-xs font-medium text-[var(--ff-text-secondary)] uppercase">Qty</th>
                </tr></thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {rows.map(r => (
                    <tr key={r.id} className="hover:bg-[var(--ff-bg-tertiary)]">
                      <td className="px-4 py-3 font-mono text-xs text-[var(--ff-text-tertiary)]">{r.itemCode}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-primary)]">{r.name}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{r.category}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-tertiary)]">{r.uom}</td>
                      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-primary)]">{fmt(r.sellingPrice)}</td>
                      <td className="px-4 py-3 text-right font-mono text-[var(--ff-text-secondary)]">{fmt(r.costPrice)}</td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{r.qtyOnHand}</td>
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
