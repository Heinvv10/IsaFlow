/**
 * Balance Sheet Report Page
 * PRD-060 Phase 5: Assets, Liabilities, Equity
 * HTML audit: chevron toggle and account-name link are siblings (BalanceSheetRow),
 * never nested — no invalid interactive-in-button.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, BarChart3, Loader2, AlertCircle, CheckCircle2,
  Download, FileSpreadsheet,
} from 'lucide-react';
import type { BalanceSheetReport } from '@/modules/accounting/types/gl.types';
import { BalanceSheetRow } from '@/components/reports/BalanceSheetRow';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';
import { EvidenceDrillModal } from '@/components/accounting/evidence/EvidenceDrillModal';

interface CostCentre { id: string; code: string; name: string }

function clampToToday(dateStr: string): string {
  const today = new Date().toISOString().split('T')[0] ?? '';
  return dateStr > today ? today : dateStr;
}

export default function BalanceSheetPage() {
  const router = useRouter();
  const qAsAt = typeof router.query.as_at_date === 'string' ? router.query.as_at_date : '';
  const today = new Date().toISOString().split('T')[0] ?? '';
  const [asAtDate, setAsAtDate] = useState(qAsAt || today);
  const [periodResolved, setPeriodResolved] = useState(!!qAsAt);
  const isMountedRef = useRef(true);

  useEffect(() => {
    if (qAsAt) setAsAtDate(qAsAt);
  }, [qAsAt]);

  useEffect(() => {
    isMountedRef.current = true;
    if (qAsAt) { setAsAtDate(qAsAt); setPeriodResolved(true); return; }
    apiFetch('/api/accounting/fiscal-periods?open_period=true', { credentials: 'include' })
      .then(r => r.json())
      .then(json => {
        if (!isMountedRef.current) return;
        const latestParam = typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search).get('as_at_date') : null;
        if (!latestParam) {
          const period = json.data as { endDate?: string } | null;
          if (period?.endDate) setAsAtDate(clampToToday(period.endDate));
        }
        setPeriodResolved(true);
      })
      .catch(() => { if (isMountedRef.current) setPeriodResolved(true); });
    return () => { isMountedRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [report, setReport] = useState<BalanceSheetReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);
  const [costCentres, setCostCentres] = useState<CostCentre[]>([]);
  const [costCentreId, setCostCentreId] = useState('');
  const [showComparative, setShowComparative] = useState(false);
  const [evidenceTarget, setEvidenceTarget] = useState<{ accountId: string; accountName: string } | null>(null);

  useEffect(() => {
    apiFetch('/api/accounting/cost-centres?active_only=true', { credentials: 'include' })
      .then(r => r.json())
      .then(json => setCostCentres(json.data?.items || json.data || []))
      .catch(() => { /* reference data load failure — non-critical */ });
  }, []);

  const loadReport = useCallback(async () => {
    if (!asAtDate || !periodResolved) return;
    setIsLoading(true); setError('');
    try {
      const params = new URLSearchParams({ as_at_date: asAtDate });
      if (costCentreId) params.set('cost_centre_id', costCentreId);
      if (showComparative) {
        const d = new Date(asAtDate); d.setFullYear(d.getFullYear() - 1);
        params.set('compare_date', d.toISOString().slice(0, 10));
      }
      const res = await apiFetch(`/api/accounting/reports-balance-sheet?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load');
      setReport(json.data || json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load balance sheet');
    } finally { setIsLoading(false); }
  }, [asAtDate, costCentreId, showComparative, periodResolved]);

  useEffect(() => { loadReport(); }, [loadReport]);

  function makeExportParams() {
    const p = new URLSearchParams({ as_at_date: asAtDate });
    if (costCentreId) p.set('cost_centre_id', costCentreId);
    return p;
  }
  function handleExport() { if (asAtDate) window.open(`/api/accounting/balance-sheet-export?${makeExportParams()}`, '_blank'); }
  function handleXlsxExport() { if (asAtDate) window.open(`/api/accounting/balance-sheet-xlsx?${makeExportParams()}`, '_blank'); }

  const balanced = report
    ? Math.abs(report.totalAssets - (report.totalLiabilities + report.totalEquity)) < 0.02
    : false;
  const drillDownStart = (asAtDate ?? '').slice(0, 4) + '-01-01';
  const drillDownEnd = asAtDate ?? '';

  const compHeader = showComparative ? (
    <span className="flex items-center gap-3 text-xs text-[var(--ff-text-tertiary)] ml-auto">
      <span className="w-24 text-right">Prior</span>
      <span className="w-24 text-right">Current</span>
      <span className="w-20 text-right">Variance</span>
    </span>
  ) : <span className="text-xs text-[var(--ff-text-tertiary)] ml-auto">Click to drill down</span>;

  function toggleAccount(code: string) {
    setExpandedAccount(prev => prev === code ? null : code);
  }

  function handleEvidence(accountId: string, accountName: string) {
    setEvidenceTarget({ accountId, accountName });
  }

  const rowProps = { onToggle: toggleAccount, onEvidenceClick: handleEvidence, showComparative, drillDownStart, drillDownEnd };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <Link href="/accounting?tab=reports" className="inline-flex items-center gap-1 text-sm text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] mb-2">
              <ArrowLeft className="h-4 w-4" /> Back to Reports
            </Link>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-blue-500/10">
                  <BarChart3 className="h-6 w-6 text-blue-500" />
                </div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Balance Sheet</h1>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={handleXlsxExport} disabled={!report}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium disabled:opacity-50">
                  <FileSpreadsheet className="h-4 w-4" /> Export Excel
                </button>
                <button onClick={handleExport} disabled={!report}
                  className="inline-flex items-center gap-2 px-4 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium disabled:opacity-50">
                  <Download className="h-4 w-4" /> Export CSV
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-4xl space-y-6">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">As at</label>
              <input type="date" value={asAtDate} onChange={e => setAsAtDate(e.target.value)} className="ff-input text-sm" />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Cost Centre</label>
              <select value={costCentreId} onChange={e => setCostCentreId(e.target.value)} className="ff-input text-sm min-w-[160px]">
                <option value="">All Cost Centres</option>
                {costCentres.map(cc => (
                  <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)] cursor-pointer select-none pb-1">
              <input type="checkbox" checked={showComparative} onChange={e => setShowComparative(e.target.checked)}
                className="rounded border-[var(--ff-border-light)]" />
              Compare prior year
            </label>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
            </div>
          ) : report ? (
            <div className="space-y-4">
              {balanced && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm">
                  <CheckCircle2 className="h-4 w-4" /> Balance sheet is balanced (A = L + E)
                </div>
              )}
              {!balanced && report.totalAssets > 0 && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
                  <AlertCircle className="h-4 w-4" /> Out of balance by {formatCurrency(Math.abs(report.totalAssets - (report.totalLiabilities + report.totalEquity)))}
                </div>
              )}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                {/* Assets */}
                <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
                  <div className="px-6 py-3 border-b border-[var(--ff-border-light)] bg-blue-500/5 flex items-center">
                    <h3 className="font-semibold text-blue-400">Assets</h3>
                    {compHeader}
                  </div>
                  <div className="divide-y divide-[var(--ff-border-light)]">
                    {report.assets.map(a => (
                      <BalanceSheetRow key={a.accountCode} account={a} isExpanded={expandedAccount === a.accountCode} {...rowProps} />
                    ))}
                    {report.assets.length === 0 && <div className="px-6 py-3 text-sm text-[var(--ff-text-tertiary)]">No asset balances</div>}
                  </div>
                  <div className="px-6 py-3 border-t border-[var(--ff-border-light)] flex justify-between bg-[var(--ff-bg-primary)]">
                    <span className="font-semibold text-[var(--ff-text-primary)]">Total Assets
                      {showComparative && report.priorTotalAssets !== undefined && (
                        <span className="text-xs text-[var(--ff-text-tertiary)] ml-2">(prior: {formatCurrency(report.priorTotalAssets)})</span>
                      )}
                    </span>
                    <span className="font-bold font-mono text-blue-400">{formatCurrency(report.totalAssets)}</span>
                  </div>
                </div>

                {/* Liabilities + Equity */}
                <div className="space-y-4">
                  <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
                    <div className="px-6 py-3 border-b border-[var(--ff-border-light)] bg-amber-500/5 flex items-center">
                      <h3 className="font-semibold text-amber-400">Liabilities</h3>
                      {compHeader}
                    </div>
                    <div className="divide-y divide-[var(--ff-border-light)]">
                      {report.liabilities.map(l => (
                        <BalanceSheetRow key={l.accountCode} account={l} isExpanded={expandedAccount === l.accountCode} {...rowProps} />
                      ))}
                      {report.liabilities.length === 0 && <div className="px-6 py-3 text-sm text-[var(--ff-text-tertiary)]">No liability balances</div>}
                    </div>
                    <div className="px-6 py-2 border-t border-[var(--ff-border-light)] flex justify-between">
                      <span className="font-medium text-sm text-[var(--ff-text-primary)]">Total Liabilities
                        {showComparative && report.priorTotalLiabilities !== undefined && (
                          <span className="text-xs text-[var(--ff-text-tertiary)] ml-2">(prior: {formatCurrency(report.priorTotalLiabilities)})</span>
                        )}
                      </span>
                      <span className="font-medium font-mono text-amber-400">{formatCurrency(report.totalLiabilities)}</span>
                    </div>
                  </div>

                  <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
                    <div className="px-6 py-3 border-b border-[var(--ff-border-light)] bg-purple-500/5 flex items-center">
                      <h3 className="font-semibold text-purple-400">Equity</h3>
                      {compHeader}
                    </div>
                    <div className="divide-y divide-[var(--ff-border-light)]">
                      {report.equity.map(e => (
                        <BalanceSheetRow key={e.accountCode} account={e} isExpanded={expandedAccount === e.accountCode} {...rowProps} />
                      ))}
                      {report.equity.length === 0 && <div className="px-6 py-3 text-sm text-[var(--ff-text-tertiary)]">No equity balances</div>}
                    </div>
                    <div className="px-6 py-2 border-t border-[var(--ff-border-light)] flex justify-between">
                      <span className="font-medium text-sm text-[var(--ff-text-primary)]">Total Equity
                        {showComparative && report.priorTotalEquity !== undefined && (
                          <span className="text-xs text-[var(--ff-text-tertiary)] ml-2">(prior: {formatCurrency(report.priorTotalEquity)})</span>
                        )}
                      </span>
                      <span className="font-medium font-mono text-purple-400">{formatCurrency(report.totalEquity)}</span>
                    </div>
                  </div>

                  <div className="px-6 py-3 bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] flex justify-between">
                    <span className="font-semibold text-[var(--ff-text-primary)]">Total L + E</span>
                    <span className="font-bold font-mono text-blue-400">{formatCurrency(report.totalLiabilities + report.totalEquity)}</span>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
      {evidenceTarget && (
        <EvidenceDrillModal
          accountId={evidenceTarget.accountId}
          accountName={evidenceTarget.accountName}
          periodStart={drillDownStart}
          periodEnd={drillDownEnd}
          onClose={() => setEvidenceTarget(null)}
        />
      )}
    </AppLayout>
  );
}
