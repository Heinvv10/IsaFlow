/**
 * Below-Threshold Assets Page
 * Lists assets whose cost falls below the capitalization threshold for their category.
 * Allows one-click expense-to-GL posting.
 * Route: /accounting/assets/below-threshold
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AlertTriangle, Loader2, CheckCircle2 } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface BelowThresholdAsset {
  id: string;
  asset_number: string;
  name: string;
  cost: number;
  threshold: number;
  category_name: string | null;
  status: string;
  created_at: string;
  belowThreshold: boolean;
  /** True once the asset has been expensed to GL — the API refuses a repeat. */
  expensed: boolean;
  suggestedTreatment: string;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export default function BelowThresholdPage() {
  const [assets, setAssets] = useState<BelowThresholdAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [posting, setPosting] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    apiFetch('/api/accounting/assets/below-threshold', { credentials: 'include' })
      .then(r => r.json())
      .then(j => { setAssets(j.data || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleExpense = async (assetId: string) => {
    setPosting(assetId);
    setError(null);
    try {
      const res = await apiFetch('/api/accounting/assets/below-threshold', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assetId }),
      });
      const json = await res.json();
      // apiResponse nests the message: { success: false, error: { code, message } }.
      if (!res.ok) { setError(json.error?.message || 'Failed to post expense'); }
      else { setDone(prev => new Set([...prev, assetId])); }
    } catch { setError('Network error'); }
    setPosting(null);
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-500/10">
              <AlertTriangle className="h-6 w-6 text-amber-500" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Below-Threshold Assets</h1>
              <p className="text-sm text-[var(--ff-text-secondary)]">
                Assets whose cost is below the capitalization threshold — should be expensed, not capitalised
              </p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {error && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)] bg-[var(--ff-bg-primary)]/40">
                  <th className="px-4 py-3">Asset #</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Category</th>
                  <th className="px-4 py-3 text-right">Cost</th>
                  <th className="px-4 py-3 text-right">Threshold</th>
                  <th className="px-4 py-3 text-right">Gap</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-[var(--ff-text-tertiary)]">
                      <Loader2 className="h-5 w-5 animate-spin inline mr-2" />Loading…
                    </td>
                  </tr>
                )}
                {!loading && assets.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-[var(--ff-text-tertiary)]">
                      <CheckCircle2 className="h-6 w-6 inline mr-2 text-teal-400" />
                      No assets below the capitalization threshold.
                    </td>
                  </tr>
                )}
                {assets.map((a, i) => {
                  // `expensed` survives a reload; `done` only covers this page view.
                  const isDone = done.has(a.id) || a.expensed === true;
                  return (
                    <tr key={a.id} className={`border-b border-[var(--ff-border-light)] ${i % 2 === 0 ? '' : 'bg-[var(--ff-bg-primary)]/10'} ${isDone ? 'opacity-50' : ''}`}>
                      <td className="px-4 py-3 font-mono text-xs font-semibold text-amber-400">{a.asset_number}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-primary)]">{a.name}</td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)] text-xs">{a.category_name ?? '—'}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-[var(--ff-text-primary)]">{fmt(a.cost)}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-[var(--ff-text-secondary)]">{fmt(a.threshold)}</td>
                      <td className="px-4 py-3 text-right font-mono text-xs text-amber-400">{fmt(a.threshold - a.cost)}</td>
                      <td className="px-4 py-3">
                        {isDone
                          ? <span className="text-xs text-teal-400 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" />Expensed</span>
                          : <span className="text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-400">Pending</span>
                        }
                      </td>
                      <td className="px-4 py-3">
                        {!isDone && (
                          <button
                            onClick={() => void handleExpense(a.id)}
                            disabled={posting === a.id}
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium bg-amber-600 hover:bg-amber-700 text-white transition-colors disabled:opacity-50"
                          >
                            {posting === a.id ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                            Post to GL
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-[var(--ff-text-tertiary)]">
            Posting to GL creates: Dr Default Expense / Cr Bank. The asset remains in the register for tracking but is excluded from the balance sheet.
          </p>
        </div>
      </div>
    </AppLayout>
  );
}
