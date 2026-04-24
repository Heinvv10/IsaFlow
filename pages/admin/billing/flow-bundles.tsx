/**
 * Admin — Flow Bundles
 * CRUD for purchasable Flow packs (Micro / Small / Medium / Large by default).
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { apiFetch } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { AlertCircle, Loader2, Plus } from 'lucide-react';

interface Bundle {
  id: string;
  name: string;
  flows: number;
  priceCents: number;
  isActive: boolean;
  displayOrder: number;
}

const emptyDraft = { name: '', flows: 0, priceCents: 0, displayOrder: 0, isActive: true };

export default function FlowBundlesPage() {
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [draft, setDraft]     = useState<typeof emptyDraft>(emptyDraft);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/admin/billing/flow-bundles');
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error?.message ?? 'Failed to load bundles');
      setBundles(json.data.bundles as Bundle[]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load bundles');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function createBundle() {
    if (!draft.name || draft.flows <= 0 || draft.priceCents < 0) {
      window.alert('Name, positive flows, and non-negative price are required');
      return;
    }
    const res = await apiFetch('/api/admin/billing/flow-bundles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
      body: JSON.stringify(draft),
    });
    const json = await res.json();
    if (!res.ok) {
      window.alert(json?.error?.message ?? 'Create failed');
      return;
    }
    setDraft(emptyDraft);
    await load();
  }

  async function toggleActive(bundle: Bundle) {
    const res = await apiFetch(`/api/admin/billing/flow-bundles/${bundle.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
      body: JSON.stringify({ isActive: !bundle.isActive }),
    });
    if (res.ok) await load();
  }

  return (
    <AdminLayout title="Flow Bundles">
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm mb-6">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden mb-6">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <h2 className="text-sm font-semibold">Create bundle</h2>
        </div>
        <div className="p-4 flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Name</label>
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              className="px-3 py-2 text-sm rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Flows</label>
            <input
              type="number" min={1}
              value={draft.flows || ''}
              onChange={(e) => setDraft({ ...draft, flows: Number(e.target.value) })}
              className="px-3 py-2 text-sm rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 w-24"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Price (cents)</label>
            <input
              type="number" min={0}
              value={draft.priceCents || ''}
              onChange={(e) => setDraft({ ...draft, priceCents: Number(e.target.value) })}
              className="px-3 py-2 text-sm rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 w-32"
            />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Order</label>
            <input
              type="number" min={0}
              value={draft.displayOrder || ''}
              onChange={(e) => setDraft({ ...draft, displayOrder: Number(e.target.value) })}
              className="px-3 py-2 text-sm rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 w-20"
            />
          </div>
          <button
            onClick={createBundle}
            className="inline-flex items-center gap-1 px-4 py-2 text-sm bg-teal-600 hover:bg-teal-700 text-white rounded"
          >
            <Plus className="w-4 h-4" /> Create
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-gray-500">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading…
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl shadow-sm overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-800 text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left px-4 py-3">Name</th>
                <th className="text-right px-4 py-3">Flows</th>
                <th className="text-right px-4 py-3">Price</th>
                <th className="text-right px-4 py-3">R/Flow</th>
                <th className="text-center px-4 py-3">Order</th>
                <th className="text-center px-4 py-3">Active</th>
                <th className="text-right px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {bundles.map((b) => (
                <tr key={b.id} className="border-t border-gray-200 dark:border-gray-700">
                  <td className="px-4 py-3">{b.name}</td>
                  <td className="px-4 py-3 text-right font-mono">{b.flows}</td>
                  <td className="px-4 py-3 text-right font-mono">{formatCurrency(b.priceCents / 100)}</td>
                  <td className="px-4 py-3 text-right font-mono">
                    {formatCurrency(b.priceCents / b.flows / 100)}
                  </td>
                  <td className="px-4 py-3 text-center">{b.displayOrder}</td>
                  <td className="px-4 py-3 text-center">{b.isActive ? '✓' : '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => toggleActive(b)}
                      className="text-xs text-teal-600 hover:text-teal-500"
                    >
                      {b.isActive ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </AdminLayout>
  );
}
