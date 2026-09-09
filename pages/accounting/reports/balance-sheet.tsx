/**
 * Balance Sheet Report Page
 * PRD-060 Phase 5: Assets, Liabilities, Equity
 * Renders through StatementGrid (see BalanceSheetBody) rather than a bespoke row.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import {
  ArrowLeft, BarChart3, Loader2, AlertCircle,
  Download, FileSpreadsheet,
} from 'lucide-react';
import type { BalanceSheetReport } from '@/modules/accounting/types/gl.types';
import { BalanceSheetBody } from '@/components/accounting/BalanceSheetBody';
import { apiFetch } from '@/lib/apiFetch';
import { EvidenceDrillModal } from '@/components/accounting/evidence/EvidenceDrillModal';
import { ComparatorControls } from '@/components/accounting/reportControls/ComparatorControls';
import { PresentLink } from '@/components/accounting/reportControls/PresentLink';
import { useStatementComparatorState } from '@/components/accounting/reportControls/useStatementComparatorState';
import { ComparatorNotices } from '@/components/accounting/reportControls/ComparatorNotices';

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
  const [evidenceTarget, setEvidenceTarget] = useState<{ accountId: string; accountName: string } | null>(null);
  // No Budget checkbox here: a budget is a P&L figure, and its account codes
  // match nothing on a balance sheet. The trend series is `balance`, not
  // `movement` — a movement series drawn beside a printed balance is a shape
  // about a different number.
  const { columns, setColumns, companyWideUnavailable, apply, budgetState, trendFailed } =
    useStatementComparatorState({
      costCentreSelected: costCentreId !== '',
      asOf: asAtDate, basis: 'balance', offersBudget: false,
    });
  const showComparative = columns.prior;
  const anyColumn = columns.prior || columns.trend;

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

  useEffect(() => { void loadReport(); }, [loadReport]);

  function makeExportParams() {
    const p = new URLSearchParams({ as_at_date: asAtDate });
    if (costCentreId) p.set('cost_centre_id', costCentreId);
    return p;
  }
  function handleExport() { if (asAtDate) window.open(`/api/accounting/balance-sheet-export?${makeExportParams()}`, '_blank'); }
  function handleXlsxExport() { if (asAtDate) window.open(`/api/accounting/balance-sheet-xlsx?${makeExportParams()}`, '_blank'); }

  const drillDownStart = (asAtDate ?? '').slice(0, 4) + '-01-01';
  const drillDownEnd = asAtDate ?? '';

  function toggleAccount(code: string) {
    setExpandedAccount(prev => prev === code ? null : code);
  }

  function handleEvidence(accountId: string, accountName: string) {
    setEvidenceTarget({ accountId, accountName });
  }

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
                {/* The balance sheet is an as-at figure with no period start
                    of its own. The deck's range is the same year-to-date
                    window the account drill-down already uses, so the two
                    surfaces cannot disagree about what "this period" means. */}
                <PresentLink from={drillDownStart} to={drillDownEnd} />
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

        {/* Two grids side by side already; a comparator column on each needs
            the wider container or both scroll horizontally. */}
        <div className={`p-6 space-y-6 ${anyColumn ? 'max-w-7xl' : 'max-w-4xl'}`}>
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
            <div className="pb-2">
              <ComparatorControls value={columns} onChange={setColumns} comparators={['prior']}
                companyWideUnavailable={companyWideUnavailable} />
            </div>
          </div>

          <ComparatorNotices budgetState={budgetState} trendFailed={trendFailed}
            companyWideUnavailable={companyWideUnavailable} />

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
            <BalanceSheetBody
                costCentreId={costCentreId}
              report={report}
              showComparative={showComparative}
              columns={columns}
              applyComparators={apply}
              expandedAccount={expandedAccount}
              onToggleAccount={toggleAccount}
              drillDownStart={drillDownStart}
              drillDownEnd={drillDownEnd}
              onEvidence={handleEvidence}
            />
          ) : null}
        </div>
      </div>
      {evidenceTarget && (
        <EvidenceDrillModal
          costCentreId={costCentreId}
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
