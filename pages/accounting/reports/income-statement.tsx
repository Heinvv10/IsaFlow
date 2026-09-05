/**
 * Income Statement (P&L) Report Page
 * PRD-060 Phase 5: Revenue, Cost of Sales, Operating Expenses
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/router';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, BarChart3, Loader2, AlertCircle, Download, FileSpreadsheet } from 'lucide-react';
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.types';
import { IncomeStatementSections } from '@/components/accounting/IncomeStatementSections';

import { formatDisplayDate } from '@/utils/dateFormat';
import { apiFetch } from '@/lib/apiFetch';
import { EvidenceDrillModal } from '@/components/accounting/evidence/EvidenceDrillModal';
import { ComparatorControls } from '@/components/accounting/reportControls/ComparatorControls';
import { useComparatorColumns } from '@/components/accounting/reportControls/useComparatorColumns';
import { useStatementComparators } from '@/components/accounting/reportControls/useStatementComparators';

interface CostCentre { id: string; code: string; name: string }

function clampToToday(dateStr: string): string {
  const today = new Date().toISOString().split('T')[0] ?? '';
  return dateStr > today ? today : dateStr;
}

function getDefaultDates(): { periodStart: string; periodEnd: string } {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  return {
    periodStart: start.toISOString().split('T')[0] ?? '',
    periodEnd: now.toISOString().split('T')[0] ?? '',
  };
}

export default function IncomeStatementPage() {
  const router = useRouter();
  const qStart = typeof router.query.period_start === 'string' ? router.query.period_start : '';
  const qEnd = typeof router.query.period_end === 'string' ? router.query.period_end : '';
  const defaults = getDefaultDates();
  const [periodStart, setPeriodStart] = useState(qStart || defaults.periodStart);
  const [periodEnd, setPeriodEnd] = useState(qEnd || defaults.periodEnd);
  const [periodResolved, setPeriodResolved] = useState(!!(qStart && qEnd));
  const isMountedRef = useRef(true);

  // Sync-back effect: when router.query.period_start / period_end populate after
  // mount (Next.js can hydrate router.query on a later tick, or client-side
  // router.push can set them after the open-period fetch has already resolved),
  // push the URL values into state so the report re-fetches correctly.
  useEffect(() => {
    if (qStart) setPeriodStart(qStart);
    if (qEnd) setPeriodEnd(qEnd);
  }, [qStart, qEnd]);

  // Fetch the current open period on mount to set smart default dates.
  // The open-period values are only written when no deep-link params are present
  // (checked both at call-time and when the promise resolves).
  useEffect(() => {
    isMountedRef.current = true;

    if (qStart && qEnd) {
      // Deep-link params present at mount — use them and skip the period fetch.
      setPeriodStart(qStart);
      setPeriodEnd(qEnd);
      setPeriodResolved(true);
      return;
    }

    apiFetch('/api/accounting/fiscal-periods?open_period=true', { credentials: 'include' })
      .then(r => r.json())
      .then(json => {
        if (!isMountedRef.current) return;
        // Guard: if deep-link params arrived after mount (router.query hydrates
        // asynchronously), do not overwrite them with the fetched period dates.
        const searchParams = typeof window !== 'undefined'
          ? new URLSearchParams(window.location.search)
          : null;
        const latestStart = searchParams?.get('period_start');
        const latestEnd = searchParams?.get('period_end');
        if (!latestStart && !latestEnd) {
          const period = json.data as { startDate?: string; endDate?: string } | null;
          if (period?.startDate) setPeriodStart(period.startDate);
          if (period?.endDate) setPeriodEnd(clampToToday(period.endDate));
        }
        setPeriodResolved(true);
      })
      .catch(() => {
        if (isMountedRef.current) setPeriodResolved(true);
      });

    return () => { isMountedRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [report, setReport] = useState<IncomeStatementReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);
  const [costCentres, setCostCentres] = useState<CostCentre[]>([]);
  const [costCentreId, setCostCentreId] = useState('');
  const [evidenceTarget, setEvidenceTarget] = useState<{ accountId: string; accountName: string } | null>(null);
  // The Prior-period checkbox IS the comparative fetch: one control, so the
  // column cannot be on with no comparative period behind it.
  const { columns, setColumns } = useComparatorColumns();
  const showComparative = columns.prior;
  const { apply, budgetAvailable } = useStatementComparators({
    trend: columns.trend, budget: columns.budget, asOf: periodEnd,
    basis: 'movement', periodStart, periodEnd,
  });

  useEffect(() => {
    apiFetch('/api/accounting/cost-centres?active_only=true', { credentials: 'include' })
      .then(r => r.json())
      .then(json => setCostCentres(json.data?.items || json.data || []))
      .catch(() => { /* reference data load failure — non-critical, cost centre filter will be empty */ });
  }, []);

  function handleExport() {
    const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
    if (costCentreId) params.set('cost_centre_id', costCentreId);
    window.open(`/api/accounting/income-statement-export?${params}`, '_blank');
  }

  function handleXlsxExport() {
    const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
    if (costCentreId) params.set('cost_centre_id', costCentreId);
    window.open(`/api/accounting/income-statement-xlsx?${params}`, '_blank');
  }

  function toggleAccount(code: string) {
    setExpandedAccount(prev => (prev === code ? null : code));
  }

  const loadReport = useCallback(async () => {
    if (!periodStart || !periodEnd || !periodResolved) return;
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
      if (costCentreId) params.set('cost_centre_id', costCentreId);
      if (showComparative) {
        const start = new Date(periodStart);
        const end = new Date(periodEnd);
        const durationMs = end.getTime() - start.getTime();
        const priorEnd = new Date(start.getTime() - 1);
        const priorStart = new Date(priorEnd.getTime() - durationMs);
        params.set('compare_start', priorStart.toISOString().split('T')[0] ?? '');
        params.set('compare_end', priorEnd.toISOString().split('T')[0] ?? '');
      }
      const res = await apiFetch(`/api/accounting/reports-income-statement?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load');
      setReport(json.data || json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load income statement');
    } finally {
      setIsLoading(false);
    }
  }, [periodStart, periodEnd, costCentreId, showComparative, periodResolved]);

  useEffect(() => { void loadReport(); }, [loadReport]);

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
                <div className="p-2 rounded-lg bg-teal-500/10">
                  <BarChart3 className="h-6 w-6 text-teal-500" />
                </div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Income Statement</h1>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={handleXlsxExport} disabled={!report}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium disabled:opacity-50">
                  <FileSpreadsheet className="h-4 w-4" /> Export Excel
                </button>
                <button onClick={handleExport} disabled={!report}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-teal-600 text-white rounded-lg hover:bg-teal-700 text-sm font-medium disabled:opacity-50">
                  <Download className="h-4 w-4" /> Export CSV
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-4xl space-y-6">
          {/* Date Range + Filters */}
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">From</label>
              <input type="date" name="periodStart" value={periodStart} onChange={e => setPeriodStart(e.target.value)} className="ff-input text-sm" />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">To</label>
              <input type="date" name="periodEnd" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} className="ff-input text-sm" />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Cost Centre</label>
              <select name="costCentreId" value={costCentreId} onChange={e => setCostCentreId(e.target.value)}
                className="ff-input text-sm min-w-[160px]">
                <option value="">All Cost Centres</option>
                {costCentres.map(cc => (
                  <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>
                ))}
              </select>
            </div>
            <div className="pb-2">
              <ComparatorControls value={columns} onChange={setColumns} />
            </div>
          </div>

          {columns.budget && budgetAvailable === false && (
            <p className="text-xs text-[var(--ff-text-tertiary)]">
              No budget has been captured for this period, so the Budget column is empty.
              Capture one under Accounting → Budgets.
            </p>
          )}

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-teal-500" />
            </div>
          ) : report ? (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <div className="px-6 py-4 border-b border-[var(--ff-border-light)]">
                <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
                  Profit &amp; Loss — {formatDisplayDate(periodStart)} to {formatDisplayDate(periodEnd)}
                </h2>
              </div>

              <IncomeStatementSections
                report={report}
                periodStart={periodStart}
                periodEnd={periodEnd}
                expandedAccount={expandedAccount}
                onToggleAccount={toggleAccount}
                showComparative={showComparative}
                columns={columns}
                applyComparators={apply}
                onEvidence={(id, name) => setEvidenceTarget({ accountId: id, accountName: name })}
              />
            </div>
          ) : null}
        </div>
      </div>
      {evidenceTarget && (
        <EvidenceDrillModal
          accountId={evidenceTarget.accountId}
          accountName={evidenceTarget.accountName}
          periodStart={periodStart}
          periodEnd={periodEnd}
          onClose={() => setEvidenceTarget(null)}
        />
      )}
    </AppLayout>
  );
}

