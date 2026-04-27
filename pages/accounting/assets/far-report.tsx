/**
 * Fixed Asset Register Report — dual-track IAS 16 + SARS wear & tear.
 * Route: /accounting/assets/far-report
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { apiFetch } from '@/lib/apiFetch';
import { ExportCSVButton } from '@/components/shared/ExportCSVButton';

interface FarAsset {
  assetNumber: string;
  assetName: string;
  categoryCode: string;
  categoryName: string;
  ias16Group: string;
  taxCode: string;
  taxLifeYears: number;
  policyLifeYears: number;
  residualPct: number;
  status: string;
  belowThreshold: boolean;
  policyCost: number;
  policyAccDep: number;
  policyCA: number;
  policyCurrentDep: number;
  policyProfitLoss: number;
  taxCost: number;
  taxAccDep: number;
  taxCA: number;
  taxCurrentDep: number;
  taxProfitLoss: number;
  deferredTax: number;
}

interface FarTotals {
  policyCost: number;
  policyAccDep: number;
  policyCA: number;
  taxCost: number;
  taxAccDep: number;
  taxCA: number;
  deferredTax: number;
}

interface FarReport {
  asAt: string;
  assets: FarAsset[];
  totals: FarTotals;
  setupRequired?: string;
}

const zar = new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt = (n: number) => zar.format(n);
const today = () => new Date().toISOString().slice(0, 10);

export default function FarReportPage() {
  const [report, setReport] = useState<FarReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [asAt, setAsAt] = useState<string>(today());

  const load = useCallback(async (date: string) => {
    setLoading(true);
    setError(null);
    const res = await apiFetch(`/api/accounting/assets/far-report?asAt=${date}`);
    const json = await res.json() as { success: boolean; data?: FarReport; error?: string };
    if (json.success && json.data) {
      setReport(json.data);
    } else {
      setError(json.error ?? 'Failed to load report');
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(asAt); }, [asAt, load]);

  const statusBadge = (status: string, belowThreshold: boolean) => (
    <span className="flex items-center gap-1">
      <span
        className={`px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider font-mono
          ${status === 'active' ? 'bg-emerald-900/60 text-emerald-300' :
            status === 'disposed' ? 'bg-red-900/60 text-red-300' :
            'bg-yellow-900/60 text-yellow-300'}`}
      >
        {status}
      </span>
      {belowThreshold && (
        <span title="Below capitalisation threshold" className="text-amber-400 text-xs">&#9888;</span>
      )}
    </span>
  );

  const numCell = (val: number) => (
    <td className="px-2 py-1.5 text-right font-mono text-xs text-[var(--ff-text-primary)] whitespace-nowrap">
      {fmt(val)}
    </td>
  );

  const totRow = report?.totals;

  return (
    <AppLayout>
      {/* ── Header bar ────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4 px-1">
        <div>
          <h1 className="text-lg font-semibold text-[var(--ff-text-primary)] tracking-tight">
            Fixed Asset Register
          </h1>
          <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">
            Dual-track: Policy (IAS&nbsp;16) + Tax (SARS wear &amp; tear)
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-[var(--ff-text-secondary)] font-medium">As at</label>
          <input
            type="date"
            value={asAt}
            onChange={e => setAsAt(e.target.value)}
            className="ff-input text-xs font-mono px-2 py-1 h-8"
          />
          <ExportCSVButton
            endpoint="/api/accounting/assets/far-report-xlsx"
            params={{ asAt }}
            filenamePrefix="FAR"
            label="Excel"
            disabled={loading}
          />
        </div>
      </div>

      {/* ── State: error ──────────────────────────────────────── */}
      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-900/30 border border-red-800 text-red-300 text-sm flex items-start justify-between gap-3">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => load(asAt)}
            className="px-2 py-1 rounded bg-red-800/60 hover:bg-red-700 text-red-100 text-xs font-medium"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── State: setup required ─────────────────────────────── */}
      {!loading && report?.setupRequired && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-amber-900/30 border border-amber-800 text-amber-200 text-sm">
          <div className="font-medium mb-1">Report not ready</div>
          <div className="text-amber-300/80">{report.setupRequired}</div>
        </div>
      )}

      {/* ── State: loading ────────────────────────────────────── */}
      {loading && (
        <div className="flex justify-center items-center h-48">
          <div className="animate-spin rounded-full h-8 w-8 border-2 border-[var(--ff-text-tertiary)] border-t-transparent" />
        </div>
      )}

      {/* ── Table ─────────────────────────────────────────────── */}
      {!loading && report && (
        <div className="overflow-x-auto rounded-lg border border-[var(--ff-border-light)]">
          <table className="w-full text-xs border-collapse">
            <thead>
              {/* Group header row */}
              <tr className="bg-[var(--ff-bg-secondary)] border-b border-[var(--ff-border-light)]">
                <th colSpan={8} className="px-2 py-2 text-left text-[var(--ff-text-tertiary)] font-medium tracking-widest uppercase text-[10px]">
                  Asset Details
                </th>
                <th colSpan={5} className="px-2 py-2 text-center text-emerald-400 font-semibold tracking-widest uppercase text-[10px] border-l border-[var(--ff-border-light)]">
                  Policy (IAS 16)
                </th>
                <th colSpan={5} className="px-2 py-2 text-center text-sky-400 font-semibold tracking-widest uppercase text-[10px] border-l border-[var(--ff-border-light)]">
                  Tax (SARS)
                </th>
                <th className="px-2 py-2 text-center text-violet-400 font-semibold tracking-widest uppercase text-[10px] border-l border-[var(--ff-border-light)]">
                  Def Tax
                </th>
              </tr>
              {/* Column header row */}
              <tr className="bg-[var(--ff-bg-secondary)] border-b-2 border-[var(--ff-border-light)]">
                {(['Asset #', 'Description', 'Code', 'IAS16', 'Tax Life', 'Pol Life', 'Res%', 'Status'] as const).map(h => (
                  <th key={h} className="px-2 py-1.5 text-left font-mono text-[10px] font-semibold text-[var(--ff-text-secondary)] whitespace-nowrap uppercase tracking-wider">
                    {h}
                  </th>
                ))}
                {(['Cost', 'Acc Dep', 'CA', 'Curr Dep', 'P/L'] as const).map(h => (
                  <th key={`p-${h}`} className={`px-2 py-1.5 text-right font-mono text-[10px] font-semibold text-emerald-400 whitespace-nowrap uppercase tracking-wider${h === 'Cost' ? ' border-l border-[var(--ff-border-light)]' : ''}`}>
                    {h}
                  </th>
                ))}
                {(['Cost', 'Acc Dep', 'CA', 'Curr Dep', 'P/L'] as const).map(h => (
                  <th key={`t-${h}`} className={`px-2 py-1.5 text-right font-mono text-[10px] font-semibold text-sky-400 whitespace-nowrap uppercase tracking-wider${h === 'Cost' ? ' border-l border-[var(--ff-border-light)]' : ''}`}>
                    {h}
                  </th>
                ))}
                <th className="px-2 py-1.5 text-right font-mono text-[10px] font-semibold text-violet-400 uppercase tracking-wider border-l border-[var(--ff-border-light)]">
                  Def Tax
                </th>
              </tr>
            </thead>
            <tbody>
              {report.assets.length === 0 && (
                <tr>
                  <td colSpan={19} className="px-4 py-8 text-center text-[var(--ff-text-tertiary)]">
                    No assets found for this period.
                  </td>
                </tr>
              )}
              {report.assets.map((a, i) => (
                <tr
                  key={a.assetNumber}
                  className={`border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-secondary)]/60 transition-colors
                    ${i % 2 === 0 ? 'bg-[var(--ff-bg-primary)]' : 'bg-[var(--ff-bg-secondary)]/40'}`}
                >
                  <td className="px-2 py-1.5 font-mono text-xs text-[var(--ff-text-secondary)] whitespace-nowrap">{a.assetNumber}</td>
                  <td className="px-2 py-1.5 text-xs text-[var(--ff-text-primary)] max-w-[160px] truncate" title={a.assetName}>{a.assetName}</td>
                  <td className="px-2 py-1.5 font-mono text-[10px] text-[var(--ff-text-tertiary)]">{a.categoryCode}</td>
                  <td className="px-2 py-1.5 font-mono text-[10px] text-[var(--ff-text-secondary)]">{a.ias16Group}</td>
                  <td className="px-2 py-1.5 font-mono text-[10px] text-right text-[var(--ff-text-tertiary)]">{a.taxLifeYears}</td>
                  <td className="px-2 py-1.5 font-mono text-[10px] text-right text-[var(--ff-text-tertiary)]">{a.policyLifeYears}</td>
                  <td className="px-2 py-1.5 font-mono text-[10px] text-right text-[var(--ff-text-tertiary)]">{a.residualPct}%</td>
                  <td className="px-2 py-1.5">{statusBadge(a.status, a.belowThreshold)}</td>
                  {/* Policy columns */}
                  <td className={`px-2 py-1.5 text-right font-mono text-xs text-[var(--ff-text-primary)] whitespace-nowrap border-l border-[var(--ff-border-light)]`}>{fmt(a.policyCost)}</td>
                  {numCell(a.policyAccDep)}
                  {numCell(a.policyCA)}
                  {numCell(a.policyCurrentDep)}
                  {numCell(a.policyProfitLoss)}
                  {/* Tax columns */}
                  <td className="px-2 py-1.5 text-right font-mono text-xs text-[var(--ff-text-primary)] whitespace-nowrap border-l border-[var(--ff-border-light)]">{fmt(a.taxCost)}</td>
                  {numCell(a.taxAccDep)}
                  {numCell(a.taxCA)}
                  {numCell(a.taxCurrentDep)}
                  {numCell(a.taxProfitLoss)}
                  {/* Deferred tax */}
                  <td className="px-2 py-1.5 text-right font-mono text-xs text-violet-300 whitespace-nowrap border-l border-[var(--ff-border-light)]">{fmt(a.deferredTax)}</td>
                </tr>
              ))}
            </tbody>
            {totRow && (
              <tfoot>
                <tr className="border-t-2 border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
                  <td colSpan={8} className="px-2 py-2 font-semibold text-xs text-[var(--ff-text-secondary)] uppercase tracking-wider">
                    Totals
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-xs font-bold text-emerald-300 border-l border-[var(--ff-border-light)]">{fmt(totRow.policyCost)}</td>
                  <td className="px-2 py-2 text-right font-mono text-xs font-bold text-emerald-300">{fmt(totRow.policyAccDep)}</td>
                  <td className="px-2 py-2 text-right font-mono text-xs font-bold text-emerald-300">{fmt(totRow.policyCA)}</td>
                  <td className="px-2 py-2 text-right font-mono text-xs text-[var(--ff-text-tertiary)]">—</td>
                  <td className="px-2 py-2 text-right font-mono text-xs text-[var(--ff-text-tertiary)]">—</td>
                  <td className="px-2 py-2 text-right font-mono text-xs font-bold text-sky-300 border-l border-[var(--ff-border-light)]">{fmt(totRow.taxCost)}</td>
                  <td className="px-2 py-2 text-right font-mono text-xs font-bold text-sky-300">{fmt(totRow.taxAccDep)}</td>
                  <td className="px-2 py-2 text-right font-mono text-xs font-bold text-sky-300">{fmt(totRow.taxCA)}</td>
                  <td className="px-2 py-2 text-right font-mono text-xs text-[var(--ff-text-tertiary)]">—</td>
                  <td className="px-2 py-2 text-right font-mono text-xs text-[var(--ff-text-tertiary)]">—</td>
                  <td className="px-2 py-2 text-right font-mono text-xs font-bold text-violet-300 border-l border-[var(--ff-border-light)]">{fmt(totRow.deferredTax)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </AppLayout>
  );
}
