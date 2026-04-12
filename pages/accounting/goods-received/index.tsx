/**
 * Goods Received Notes (GRN) List Page
 */

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import { PackageCheck, Plus, Search, Loader2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface GRN {
  id: string;
  grn_number: string;
  po_number: string | null;
  supplier_name: string | null;
  received_date: string;
  received_by: string | null;
  notes: string | null;
}

function dateStr(d: unknown): string {
  if (!d) return '—';
  const s = d instanceof Date ? (d as Date).toISOString() : String(d);
  return s.split('T')[0] ?? s;
}

export default function GoodsReceivedPage() {
  const router = useRouter();
  const [grns, setGrns] = useState<GRN[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/accounting/goods-received');
      const json = await res.json();
      const d = json.data || json;
      setGrns(Array.isArray(d) ? d : []);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load GRNs');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = search
    ? grns.filter(
        (g) =>
          g.grn_number?.toLowerCase().includes(search.toLowerCase()) ||
          g.po_number?.toLowerCase().includes(search.toLowerCase()) ||
          g.supplier_name?.toLowerCase().includes(search.toLowerCase())
      )
    : grns;

  return (
    <AppLayout>
      <div className="min-h-screen bg-slate-50 dark:bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="relative overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-6 py-8">
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, white 1px, transparent 0)', backgroundSize: '24px 24px' }} />
          <div className="absolute -top-12 right-8 w-72 h-72 bg-amber-500/10 rounded-full blur-3xl pointer-events-none" />
          <div className="relative z-10 flex items-center justify-between">
            <div>
              <p className="text-amber-400 text-xs font-semibold uppercase tracking-widest mb-1">Purchasing</p>
              <h1 className="text-2xl font-bold text-white">Goods Received</h1>
              <p className="text-slate-400 text-sm mt-0.5">{filtered.length} {filtered.length === 1 ? 'note' : 'notes'}</p>
            </div>
            <button
              onClick={() => router.push('/accounting/goods-received/new')}
              className="flex items-center gap-2 px-4 py-2.5 bg-amber-500 hover:bg-amber-400 text-white rounded-xl text-sm font-semibold transition-colors shadow-lg shadow-amber-500/25"
            >
              <Plus className="w-4 h-4" /> New GRN
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400 rounded-xl px-4 py-3 text-sm">
              {error}
            </div>
          )}

          {/* Search */}
          <div className="flex justify-end">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search GRNs..."
                className="pl-9 pr-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/30 focus:border-amber-500 text-slate-900 dark:text-slate-100 transition-colors w-56"
              />
            </div>
          </div>

          {/* Table */}
          <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 overflow-hidden shadow-sm">
            {loading ? (
              <div className="p-16 flex items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-16 text-center">
                <div className="w-14 h-14 rounded-2xl bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-4">
                  <PackageCheck className="w-7 h-7 text-slate-400" />
                </div>
                <h3 className="text-base font-semibold text-slate-900 dark:text-white">No goods received notes</h3>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Record your first delivery</p>
                <button
                  onClick={() => router.push('/accounting/goods-received/new')}
                  className="mt-5 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-white text-sm font-semibold rounded-lg transition-colors"
                >
                  New GRN
                </button>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead className="bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200 dark:border-slate-800">
                  <tr>
                    {['GRN #', 'PO Reference', 'Supplier', 'Received Date', 'Received By', 'Notes'].map((h, i) => (
                      <th key={i} className="px-5 py-3 text-left text-xs font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                  {filtered.map((g) => (
                    <tr key={g.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/30 transition-colors">
                      <td className="px-5 py-3.5 font-mono text-amber-500 font-semibold">{g.grn_number}</td>
                      <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400">{g.po_number || '—'}</td>
                      <td className="px-5 py-3.5 text-slate-900 dark:text-slate-100 font-medium">{g.supplier_name || '—'}</td>
                      <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400 text-xs">{dateStr(g.received_date)}</td>
                      <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400">{g.received_by || '—'}</td>
                      <td className="px-5 py-3.5 text-slate-500 dark:text-slate-400">{g.notes || '—'}</td>
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
