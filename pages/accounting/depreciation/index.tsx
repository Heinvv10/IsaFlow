/**
 * Asset Depreciation Page
 * Phase 4: Run monthly depreciation and view GL-linked results
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { TrendingDown, Play, Loader2 } from 'lucide-react';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import {
  calculatePolicyDepreciation,
  toDepreciationMethod,
} from '@/modules/accounting/services/items/farDepreciationService';
import { fmtDate } from '@/lib/fmtDate';
// Type-only, so it is erased at compile time and the service never reaches the
// client bundle. The page used to redeclare this shape with an `amount` field
// the API has never returned, which rendered "RNaN" in every row — `tsc` could
// not see it because the local interface was asserted over the parsed JSON.
import type {
  DepreciationRunResult,
  DepreciationRunResultRow,
} from '@/modules/accounting/services/items/depreciationRunService';

type DepRun = Pick<DepreciationRunResult, 'processed' | 'skipped' | 'total' | 'results'>;

/** Posted, no charge this period, or a real failure. Only the last is red. */
function runOutcome(r: DepreciationRunResultRow): { label: string; className: string } {
  if (r.entryId) return { label: 'GL Posted', className: 'text-teal-400 text-xs' };
  // A life-expired asset simply has no charge. Rendering it as "GL Failed"
  // sent an operator hunting for a failure that never happened.
  if (r.lifeExpiredNote) return { label: 'No charge', className: 'text-[var(--ff-text-tertiary)] text-xs' };
  return { label: 'GL Failed', className: 'text-red-400 text-xs' };
}

interface AssetRow {
  id: string;
  asset_number: string;
  name: string;
  purchase_price: number;
  current_book_value: number;
  accumulated_depreciation: number;
  useful_life_years: number;
  salvage_value: number;
  depreciation_method: string | null;
  purchase_date: string | null;
  disposal_date: string | null;
  category?: string;
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

/** The charge the run would post for this asset — its method, not straight line. */
export function monthlyCharge(a: AssetRow, today: Date = new Date()): number {
  const pp = Number(a.purchase_price);
  const sv = Number(a.salvage_value || 0);
  const uly = Number(a.useful_life_years);
  if (!(pp > 0) || !(uly > 0)) return 0;
  return calculatePolicyDepreciation({
    cost: pp,
    residualPct: sv / pp,
    usefulLifeYears: uly,
    purchaseDate: fmtDate(a.purchase_date ?? today),
    periodDate: fmtDate(today),
    openingAccDep: Number(a.accumulated_depreciation || 0),
    method: toDepreciationMethod(a.depreciation_method),
    ...(a.disposal_date ? { disposalDate: fmtDate(a.disposal_date) } : {}),
  }).monthlyDep;
}

export default function DepreciationPage() {
  const [assets, setAssets] = useState<AssetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<DepRun | null>(null);
  const [error, setError] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');

  const loadAssets = useCallback(async () => {
    try {
      const res = await apiFetch('/api/accounting/assets?status=available,assigned,in_maintenance&limit=200', {
        credentials: 'include',
      });
      const json = await res.json();
      const list = json.data?.items || json.data?.assets || json.data || [];
      setAssets(
        (Array.isArray(list) ? list : []).filter(
          (a: AssetRow) =>
            Number(a.purchase_price) > 0 &&
            Number(a.useful_life_years) > 0
        )
      );
    } catch (err) {
      log.error('Failed to load depreciable assets', { error: err }, 'depreciation-page');
      setAssets([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  const categories = [...new Set(assets.map(a => a.category || 'Uncategorized'))].sort();
  const filteredAssets = assets.filter(a => !categoryFilter || (a.category || 'Uncategorized') === categoryFilter);

  const runDepreciation = async () => {
    setError('');
    setRunning(true);
    try {
      const res = await apiFetch('/api/accounting/run-depreciation', {
        method: 'POST',
        credentials: 'include',
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed');
      setLastRun(json.data);
      await loadAssets();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed');
    } finally {
      setRunning(false);
    }
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-purple-500/10">
                <TrendingDown className="h-6 w-6 text-purple-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">
                  Asset Depreciation
                </h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Monthly depreciation on each asset&apos;s own method, posted to the GL
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ExportCSVButton endpoint="/api/accounting/depreciation-export" filenamePrefix="depreciation" label="Export CSV" />
              <button
                onClick={runDepreciation}
                disabled={running}
                className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm font-medium disabled:opacity-50"
              >
                {running ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-4 w-4" />
                )}
                Run Monthly Depreciation
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-4">
          {categories.length > 1 && (
            <div className="flex items-center gap-3">
              <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} className="ff-select text-sm">
                <option value="">All Categories</option>
                {categories.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <span className="text-sm text-[var(--ff-text-secondary)]">{filteredAssets.length} assets</span>
            </div>
          )}

          {error && (
            <div className="p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">{error}</div>
          )}

          {lastRun && (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
              <h2 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-2">
                Last Run Results
              </h2>
              <div className="flex gap-6 text-sm mb-3">
                <span className="text-teal-400">
                  Processed: {lastRun.processed}
                </span>
                <span className="text-[var(--ff-text-secondary)]">
                  Skipped: {lastRun.skipped}
                </span>
                <span className="text-[var(--ff-text-secondary)]">
                  Total Assets: {lastRun.total}
                </span>
              </div>
              {lastRun.results.length > 0 && (
                <div className="space-y-1">
                  {lastRun.results.map((r, i) => {
                    const outcome = runOutcome(r);
                    return (
                      <div key={i} className="px-2 py-1 rounded bg-[var(--ff-bg-primary)]">
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-[var(--ff-text-primary)]">{r.assetNumber}</span>
                          <span className="text-[var(--ff-text-secondary)]">{fmt(r.policyDep)}</span>
                          <span className={outcome.className}>{outcome.label}</span>
                        </div>
                        {r.lifeExpiredNote && (
                          <p className="text-xs text-amber-400 mt-0.5">{r.lifeExpiredNote}</p>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                  <th className="px-4 py-3">Asset</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3 text-right">Purchase Price</th>
                  <th className="px-4 py-3 text-right">Book Value</th>
                  <th className="px-4 py-3 text-right">Accum. Depreciation</th>
                  <th className="px-4 py-3">Life (yrs)</th>
                  <th className="px-4 py-3 text-right">Monthly Dep.</th>
                </tr>
              </thead>
              <tbody>
                {loading && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      Loading...
                    </td>
                  </tr>
                )}
                {!loading && assets.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                      No depreciable assets found
                    </td>
                  </tr>
                )}
                {filteredAssets.map((a) => {
                  const pp = Number(a.purchase_price);
                  const uly = Number(a.useful_life_years);
                  // The run's own calculator. This column used to hard-code
                  // straight line and so contradicted the journals for exactly
                  // the assets this programme corrected.
                  const monthly = monthlyCharge(a);
                  const bv = Number(a.current_book_value ?? pp);
                  const accum = Number(a.accumulated_depreciation || 0);
                  return (
                    <tr
                      key={a.id}
                      className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50"
                    >
                      <td className="px-4 py-3 text-[var(--ff-text-primary)] font-medium">
                        {a.asset_number}
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)] truncate max-w-[200px]">
                        {a.name}
                      </td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">
                        {fmt(pp)}
                      </td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">
                        {fmt(bv)}
                      </td>
                      <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)]">
                        {fmt(accum)}
                      </td>
                      <td className="px-4 py-3 text-[var(--ff-text-secondary)]">{uly}</td>
                      <td className="px-4 py-3 text-right text-purple-400">{fmt(monthly)}</td>
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
