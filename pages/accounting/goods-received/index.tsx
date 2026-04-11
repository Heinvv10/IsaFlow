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

  useEffect(() => {
    load();
  }, [load]);

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
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        {/* Header */}
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-teal-500/10">
                <PackageCheck className="h-6 w-6 text-teal-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                  Goods Received Notes
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  {filtered.length} GRN{filtered.length !== 1 ? 's' : ''}
                </p>
              </div>
            </div>
            <button
              onClick={() => router.push('/accounting/goods-received/new')}
              className="flex items-center gap-1.5 px-4 py-2 bg-teal-600 hover:bg-teal-500 text-white rounded-lg text-sm"
            >
              <Plus className="h-4 w-4" /> New GRN
            </button>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 rounded-lg px-4 py-3 text-sm">
              {error}
            </div>
          )}

          {/* Search */}
          <div className="flex justify-end">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--ff-text-tertiary)]" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search GRNs..."
                className="ff-input pl-9 text-sm w-64"
              />
            </div>
          </div>

          {/* Table */}
          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            {loading ? (
              <div className="p-8 text-center">
                <Loader2 className="h-6 w-6 animate-spin text-[var(--ff-text-tertiary)] mx-auto" />
              </div>
            ) : filtered.length === 0 ? (
              <div className="p-8 text-center text-[var(--ff-text-secondary)]">
                No goods received notes found
              </div>
            ) : (
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                      GRN #
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                      PO Reference
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                      Supplier
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                      Received Date
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                      Received By
                    </th>
                    <th className="px-4 py-3 text-left text-xs font-medium text-[var(--ff-text-secondary)] uppercase">
                      Notes
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--ff-border-light)]">
                  {filtered.map((g) => (
                    <tr key={g.id} className="hover:bg-[var(--ff-bg-tertiary)] transition-colors">
                      <td className="px-4 py-3 text-sm font-mono text-teal-400">{g.grn_number}</td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-secondary)]">
                        {g.po_number || '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-primary)]">
                        {g.supplier_name || '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-secondary)]">
                        {dateStr(g.received_date)}
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-secondary)]">
                        {g.received_by || '—'}
                      </td>
                      <td className="px-4 py-3 text-sm text-[var(--ff-text-secondary)]">
                        {g.notes || '—'}
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
