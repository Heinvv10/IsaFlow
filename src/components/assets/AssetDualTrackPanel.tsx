/**
 * Asset Dual-Track Panel — Policy vs Tax depreciation tabs.
 * Loaded on the asset detail page. Fetches period ledger rows for the asset.
 */

import { useState, useEffect } from 'react';
import { Loader2, TrendingDown, Receipt, AlertTriangle } from 'lucide-react';
import { apiFetch } from '@/lib/apiFetch';

interface PeriodRow {
  yyyymm: string;
  periodDate: string;
  policyCost: number | null;
  policyOpeningAccDep: number | null;
  policyCurrentDep: number | null;
  policyClosingAccDep: number | null;
  policyCarryingAmount: number | null;
  taxCost: number | null;
  taxOpeningAccDep: number | null;
  taxCurrentDep: number | null;
  taxClosingAccDep: number | null;
  taxCarryingAmount: number | null;
  deferredTax: number | null;
  disposalProceeds: number | null;
  policyProfitLoss: number | null;
  taxProfitLoss: number | null;
}

const fmt = (n: number | null | undefined) =>
  n != null ? new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR', maximumFractionDigits: 0 }).format(n) : '—';

const fmtSmall = (n: number | null | undefined) =>
  n != null ? new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n) : '—';

const periodLabel = (yyyymm: string) => {
  const y = yyyymm.slice(0, 4);
  const m = Number(yyyymm.slice(4, 6));
  return `${new Date(0, m - 1).toLocaleString('en-ZA', { month: 'short' })} ${y}`;
};

const thCls = 'px-3 py-2 text-right text-xs font-medium text-[var(--ff-text-secondary)] whitespace-nowrap';
const tdCls = 'px-3 py-2 text-right font-mono text-xs text-[var(--ff-text-primary)] tabular-nums';
const tdDim = 'px-3 py-2 text-right font-mono text-xs text-[var(--ff-text-tertiary)] tabular-nums';

type TrackTab = 'policy' | 'tax' | 'deferred';

export function AssetDualTrackPanel({ assetId }: { assetId: string }) {
  const [rows, setRows] = useState<PeriodRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TrackTab>('policy');

  useEffect(() => {
    setLoading(true);
    apiFetch(`/api/accounting/assets/${assetId}/period-ledger`, { credentials: 'include' })
      .then(r => r.json())
      .then(j => { setRows(j.data || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, [assetId]);

  if (loading) return (
    <div className="flex items-center justify-center py-12 text-[var(--ff-text-tertiary)]">
      <Loader2 className="h-5 w-5 animate-spin mr-2" />Loading period data…
    </div>
  );

  if (rows.length === 0) return (
    <div className="flex flex-col items-center justify-center py-12 gap-2 text-[var(--ff-text-tertiary)]">
      <AlertTriangle className="h-8 w-8 opacity-40" />
      <p className="text-sm">No depreciation periods recorded yet. Run a depreciation cycle first.</p>
    </div>
  );

  const tabs: { id: TrackTab; label: string; icon: React.ReactNode }[] = [
    { id: 'policy', label: 'Policy (IAS 16)', icon: <TrendingDown className="h-4 w-4" /> },
    { id: 'tax',    label: 'Tax (SARS W&T)',  icon: <Receipt className="h-4 w-4" /> },
    { id: 'deferred', label: 'Deferred Tax',  icon: <span className="text-xs font-bold">ΔT</span> },
  ];

  return (
    <div className="space-y-3">
      {/* Tab bar */}
      <div className="flex gap-1 border-b border-[var(--ff-border-light)]">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === t.id
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)]'
            }`}
          >
            {t.icon}{t.label}
          </button>
        ))}
      </div>

      {/* Policy tab */}
      {tab === 'policy' && (
        <div className="overflow-x-auto rounded-lg border border-[var(--ff-border-light)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--ff-bg-secondary)]">
              <tr className="border-b border-[var(--ff-border-light)]">
                <th className="px-3 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)]">Period</th>
                <th className={thCls}>Cost</th>
                <th className={thCls}>Opening Acc Dep</th>
                <th className={thCls}>Current Dep</th>
                <th className={thCls}>Closing Acc Dep</th>
                <th className={`${thCls} text-blue-400`}>Carrying Amount</th>
                {rows.some(r => r.policyProfitLoss != null) && <th className={thCls}>Gain / Loss</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.yyyymm} className={`border-b border-[var(--ff-border-light)] ${i % 2 === 0 ? '' : 'bg-[var(--ff-bg-secondary)]/30'} ${r.disposalProceeds != null ? 'bg-red-500/5' : ''}`}>
                  <td className="px-3 py-2 text-xs text-[var(--ff-text-secondary)] font-medium">{periodLabel(r.yyyymm)}</td>
                  <td className={tdDim}>{fmtSmall(r.policyCost)}</td>
                  <td className={tdDim}>{fmtSmall(r.policyOpeningAccDep)}</td>
                  <td className={`${r.policyCurrentDep ? tdCls : tdDim}`}>{fmtSmall(r.policyCurrentDep)}</td>
                  <td className={tdDim}>{fmtSmall(r.policyClosingAccDep)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-blue-400 font-semibold tabular-nums">{fmt(r.policyCarryingAmount)}</td>
                  {rows.some(row => row.policyProfitLoss != null) && (
                    <td className={r.policyProfitLoss != null ? (r.policyProfitLoss >= 0 ? 'px-3 py-2 text-right font-mono text-xs text-teal-400 tabular-nums' : 'px-3 py-2 text-right font-mono text-xs text-red-400 tabular-nums') : tdDim}>
                      {fmtSmall(r.policyProfitLoss)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Tax tab */}
      {tab === 'tax' && (
        <div className="overflow-x-auto rounded-lg border border-[var(--ff-border-light)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--ff-bg-secondary)]">
              <tr className="border-b border-[var(--ff-border-light)]">
                <th className="px-3 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)]">Period</th>
                <th className={thCls}>Tax Cost</th>
                <th className={thCls}>Opening Tax Acc Dep</th>
                <th className={thCls}>SARS W&T Dep</th>
                <th className={thCls}>Closing Tax Acc Dep</th>
                <th className={`${thCls} text-amber-400`}>Tax Carrying Amount</th>
                {rows.some(r => r.taxProfitLoss != null) && <th className={thCls}>Tax Gain / Loss</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.yyyymm} className={`border-b border-[var(--ff-border-light)] ${i % 2 === 0 ? '' : 'bg-[var(--ff-bg-secondary)]/30'}`}>
                  <td className="px-3 py-2 text-xs text-[var(--ff-text-secondary)] font-medium">{periodLabel(r.yyyymm)}</td>
                  <td className={tdDim}>{fmtSmall(r.taxCost)}</td>
                  <td className={tdDim}>{fmtSmall(r.taxOpeningAccDep)}</td>
                  <td className={`${r.taxCurrentDep ? tdCls : tdDim}`}>{fmtSmall(r.taxCurrentDep)}</td>
                  <td className={tdDim}>{fmtSmall(r.taxClosingAccDep)}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs text-amber-400 font-semibold tabular-nums">{fmt(r.taxCarryingAmount)}</td>
                  {rows.some(row => row.taxProfitLoss != null) && (
                    <td className={r.taxProfitLoss != null ? (r.taxProfitLoss >= 0 ? 'px-3 py-2 text-right font-mono text-xs text-teal-400 tabular-nums' : 'px-3 py-2 text-right font-mono text-xs text-red-400 tabular-nums') : tdDim}>
                      {fmtSmall(r.taxProfitLoss)}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Deferred tax tab */}
      {tab === 'deferred' && (
        <div className="overflow-x-auto rounded-lg border border-[var(--ff-border-light)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--ff-bg-secondary)]">
              <tr className="border-b border-[var(--ff-border-light)]">
                <th className="px-3 py-2 text-left text-xs font-medium text-[var(--ff-text-secondary)]">Period</th>
                <th className={thCls}>Policy CA</th>
                <th className={thCls}>Tax CA</th>
                <th className={thCls}>Temp Difference</th>
                <th className={`${thCls} text-violet-400`}>Deferred Tax</th>
                <th className={thCls}>Type</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const diff = (r.taxCarryingAmount ?? 0) - (r.policyCarryingAmount ?? 0);
                const isLiability = diff > 0;
                return (
                  <tr key={r.yyyymm} className={`border-b border-[var(--ff-border-light)] ${i % 2 === 0 ? '' : 'bg-[var(--ff-bg-secondary)]/30'}`}>
                    <td className="px-3 py-2 text-xs text-[var(--ff-text-secondary)] font-medium">{periodLabel(r.yyyymm)}</td>
                    <td className={tdDim}>{fmt(r.policyCarryingAmount)}</td>
                    <td className={tdDim}>{fmt(r.taxCarryingAmount)}</td>
                    <td className={diff !== 0 ? tdCls : tdDim}>{fmtSmall(diff)}</td>
                    <td className="px-3 py-2 text-right font-mono text-xs text-violet-400 font-semibold tabular-nums">{fmtSmall(r.deferredTax)}</td>
                    <td className="px-3 py-2 text-center">
                      {r.deferredTax != null && r.deferredTax !== 0 && (
                        <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${isLiability ? 'bg-red-500/10 text-red-400' : 'bg-teal-500/10 text-teal-400'}`}>
                          {isLiability ? 'Liability' : 'Asset'}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
