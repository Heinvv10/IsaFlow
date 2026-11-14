/**
 * Admin — Flow Bundles
 * CRUD for purchasable Flow packs (Micro / Small / Medium / Large by default).
 */

import { useState, useEffect, useCallback } from 'react';
import { AdminLayout } from '@/components/admin/AdminLayout';
import { ConfirmModal } from '@/components/admin/ConfirmModal';
import { apiFetch, apiErrorMessage, assertOk } from '@/lib/apiFetch';
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

// The price is typed in rands, like Plans (audit 4.17: it was cents here); the API stores cents.
const emptyDraft = { name: '', flows: 0, priceRands: '', displayOrder: 0, isActive: true };
const INPUT = 'px-3 py-2 text-sm rounded border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900';

export default function FlowBundlesPage() {
  const [bundles, setBundles] = useState<Bundle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState('');
  const [draft, setDraft]     = useState<typeof emptyDraft>(emptyDraft);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const [deactivating, setDeactivating] = useState<Bundle | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await apiFetch('/api/admin/billing/flow-bundles');
      await assertOk(res, 'Could not load bundles - try again');
      const json = await res.json();
      setBundles(json.data.bundles as Bundle[]);
    } catch (err) {
      setBundles([]);
      setError(apiErrorMessage(err, 'Could not load bundles - try again'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function createBundle() {
    if (creating) return; // one bundle per click (audit 4.17: a double click created two)
    const rands = Number(draft.priceRands);
    if (!draft.name || draft.flows <= 0 || draft.priceRands.trim() === '' || !Number.isFinite(rands) || rands < 0) {
      setCreateError('Name, positive flows, and a non-negative price in rands are required');
      return;
    }
    setCreating(true); setCreateError('');
    try {
      const res = await apiFetch('/api/admin/billing/flow-bundles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({
          name: draft.name, flows: draft.flows, priceCents: Math.round(rands * 100),
          displayOrder: draft.displayOrder, isActive: draft.isActive,
        }),
      });
      await assertOk(res, 'Could not create the bundle - try again');
      setDraft(emptyDraft);
      await load();
    } catch (err) {
      setCreateError(apiErrorMessage(err, 'Could not create the bundle - try again'));
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(bundle: Bundle) {
    setDeactivating(null);
    try {
      const res = await apiFetch(`/api/admin/billing/flow-bundles/${bundle.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Request': 'true' },
        body: JSON.stringify({ isActive: !bundle.isActive }),
      });
      await assertOk(res, 'Could not update the bundle - try again');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not update the bundle - try again'));
      return;
    }
    await load();
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
        {createError && (
          <div className="mx-4 mt-4 flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" /> {createError}
          </div>
        )}
        <div className="p-4 flex flex-wrap gap-3 items-end">
          <div>
            <label htmlFor="bundle-name" className="block text-xs text-gray-500 mb-1">Name</label>
            <input id="bundle-name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={INPUT} />
          </div>
          <div>
            <label htmlFor="bundle-flows" className="block text-xs text-gray-500 mb-1">Flows</label>
            <input id="bundle-flows" type="number" min={1} value={draft.flows || ''}
              onChange={(e) => setDraft({ ...draft, flows: Number(e.target.value) })} className={`${INPUT} w-24`} />
          </div>
          <div>
            <label htmlFor="bundle-price" className="block text-xs text-gray-500 mb-1">Price (R)</label>
            <input id="bundle-price" type="number" min={0} step="0.01" value={draft.priceRands}
              onChange={(e) => setDraft({ ...draft, priceRands: e.target.value })} className={`${INPUT} w-32`} />
          </div>
          <div>
            <label htmlFor="bundle-order" className="block text-xs text-gray-500 mb-1">Order</label>
            <input id="bundle-order" type="number" min={0} value={draft.displayOrder || ''}
              onChange={(e) => setDraft({ ...draft, displayOrder: Number(e.target.value) })} className={`${INPUT} w-20`} />
          </div>
          <button
            onClick={() => void createBundle()}
            disabled={creating}
            className="inline-flex items-center gap-1 px-4 py-2 text-sm bg-brand-600 hover:bg-brand-700 text-white rounded disabled:opacity-50"
          >
            {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />} Create
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
                  <td className="px-4 py-3 text-right tabular-nums">{b.flows}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{formatCurrency(b.priceCents / 100)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatCurrency(b.priceCents / b.flows / 100)}
                  </td>
                  <td className="px-4 py-3 text-center">{b.displayOrder}</td>
                  <td className="px-4 py-3 text-center">{b.isActive ? '✓' : '—'}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => (b.isActive ? setDeactivating(b) : void toggleActive(b))}
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
      <ConfirmModal
        open={deactivating !== null}
        title="Deactivate bundle"
        message={<>Tenants can no longer buy <strong>{deactivating?.name}</strong>. Flows already bought are kept.</>}
        confirmLabel="Deactivate"
        onConfirm={() => { if (deactivating) void toggleActive(deactivating); }}
        onCancel={() => setDeactivating(null)}
      />
    </AdminLayout>
  );
}
