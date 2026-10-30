/**
 * Balance Sheet Report Page
 * PRD-060 Phase 5: Assets, Liabilities, Equity
 * Renders through StatementGrid (see BalanceSheetBody) rather than a bespoke row.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { DateField } from '@/components/ui/DateField';
import { AppLayout } from '@/components/layout/AppLayout';
import { ListSkeleton } from '@/components/ui/ListSkeleton';
import { PageHeader } from '@/components/ui/PageHeader';
import {
  BarChart3, AlertCircle,
  Download, FileSpreadsheet,
} from 'lucide-react';
import type { BalanceSheetReport } from '@/modules/accounting/types/gl.types';
import { BalanceSheetBody } from '@/components/accounting/BalanceSheetBody';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { EvidenceDrillModal } from '@/components/accounting/evidence/EvidenceDrillModal';
import { ComparatorControls } from '@/components/accounting/reportControls/ComparatorControls';
import { PresentLink } from '@/components/accounting/reportControls/PresentLink';
import { useStatementComparatorState } from '@/components/accounting/reportControls/useStatementComparatorState';
import { ComparatorNotices } from '@/components/accounting/reportControls/ComparatorNotices';

import { useBalanceSheetFilters } from '@/components/reports/useBalanceSheetFilters';
import { reportHref } from '@/components/reports/reportReturnState';
import { shiftYearISO } from '@/lib/dateUtils';

interface CostCentre { id: string; code: string; name: string }
interface BusinessUnit { id: string; code: string; name: string }

export default function BalanceSheetPage() {
  const { asAtDate, setAsAtDate, costCentreId, setCostCentreId,
    businessUnitId, setBusinessUnitId, queryKey, periodResolved, periodError } = useBalanceSheetFilters();
  const restoredColumns = useRef('');
  const [columnsReadyKey, setColumnsReadyKey] = useState('');
  const reportRequestRef = useRef(0);

  const [report, setReport] = useState<BalanceSheetReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);
  const [costCentres, setCostCentres] = useState<CostCentre[]>([]);
  const [businessUnits, setBusinessUnits] = useState<BusinessUnit[]>([]);
  const [refError, setRefError] = useState<Record<string, string>>({});
  const [evidenceTarget, setEvidenceTarget] = useState<{ accountId: string; accountName: string } | null>(null);
  // No Budget checkbox here: a budget is a P&L figure, and its account codes
  // match nothing on a balance sheet. The trend series is `balance`, not
  // `movement` — a movement series drawn beside a printed balance is a shape
  // about a different number.
  const { columns, setColumns, companyWideUnavailable, apply, budgetState, trendFailed } =
    useStatementComparatorState({
      dimensionSelected: costCentreId !== '' || businessUnitId !== '',
      asOf: asAtDate, basis: 'balance', offersBudget: false,
    });
  useEffect(() => {
    if (!periodResolved || restoredColumns.current === queryKey) return;
    const query = new URL(queryKey, 'https://report.invalid').searchParams;
    if (query.has('prior')) {
      setColumns({ ...columns, prior: query.get('prior') === 'true',
        variance: query.get('variance') === 'true', trend: query.get('trend') === 'true' });
    }
    restoredColumns.current = queryKey;
    setColumnsReadyKey(queryKey);
  }, [periodResolved, queryKey, columns, setColumns]);
  const filtersReady = periodResolved && columnsReadyKey === queryKey;
  const returnTo = reportHref('bs', { as_at_date: asAtDate, cost_centre_id: costCentreId,
    business_unit_id: businessUnitId,
    prior: String(columns.prior), variance: String(columns.variance), trend: String(columns.trend) });
  const showComparative = columns.prior;

  useEffect(() => {
    apiFetch('/api/accounting/cost-centres?active_only=true', { credentials: 'include' })
      .then(async r => { await assertOk(r, 'Could not load the cost centres - try again'); return r.json(); })
      .then(json => setCostCentres(json.data?.items || json.data || []))
      .catch(err => { setCostCentres([]); log.warn('Failed to load cost centres', { err }, 'balance-sheet'); setRefError(p => ({ ...p, cc: apiErrorMessage(err, 'Could not load the cost centres - try again') })); });
    apiFetch('/api/accounting/business-units?active=true', { credentials: 'include' })
      .then(async r => { await assertOk(r, 'Could not load the business units - try again'); return r.json(); })
      .then(json => {
        const items = json.data?.items || json.data || [];
        setBusinessUnits(Array.isArray(items) ? items : []);
      })
      .catch(err => { setBusinessUnits([]); log.warn('Failed to load business units', { err }, 'balance-sheet'); setRefError(p => ({ ...p, bu: apiErrorMessage(err, 'Could not load the business units - try again') })); });
  }, []);

  const loadReport = useCallback(async () => {
    if (!asAtDate || !filtersReady) { reportRequestRef.current += 1; return; }
    const requestId = ++reportRequestRef.current;
    setReport(null);
    setIsLoading(true); setError('');
    try {
      const params = new URLSearchParams({ as_at_date: asAtDate });
      if (costCentreId) params.set('cost_centre_id', costCentreId);
      if (businessUnitId) params.set('business_unit_id', businessUnitId);
      if (showComparative) {
        params.set('compare_date', shiftYearISO(asAtDate, -1));
      }
      const res = await apiFetch(`/api/accounting/reports-balance-sheet?${params}`);
      await assertOk(res, 'Could not load the balance sheet - try again');
      const json = await res.json();
      if (requestId === reportRequestRef.current) setReport(json.data || json);
    } catch (err) {
      if (requestId === reportRequestRef.current) {
        setReport(null);
        setError(apiErrorMessage(err, 'Could not load balance sheet - try again'));
      }
    } finally {
      if (requestId === reportRequestRef.current) setIsLoading(false);
    }
  }, [asAtDate, costCentreId, businessUnitId, showComparative, filtersReady]);

  useEffect(() => { void loadReport(); }, [loadReport]);

  function makeExportParams() {
    const p = new URLSearchParams({ as_at_date: asAtDate });
    if (costCentreId) p.set('cost_centre_id', costCentreId);
    if (businessUnitId) p.set('business_unit_id', businessUnitId);
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
        <PageHeader
          icon={BarChart3}
          title="Balance Sheet"
          breadcrumb={[{ label: 'Reports', href: '/accounting?tab=reports' }, { label: 'Balance Sheet' }]}
          chipColor="bg-blue-500/10 text-blue-700 dark:text-blue-400"
          className="mb-0"
          actions={
            <>
              {/* The balance sheet is an as-at figure with no period start
                  of its own. The deck's range is the same year-to-date
                  window the account drill-down already uses, so the two
                  surfaces cannot disagree about what "this period" means. */}
              <PresentLink from={drillDownStart} to={drillDownEnd} />
              <button onClick={handleXlsxExport} disabled={!report}
                className="inline-flex items-center gap-2 px-4 py-2 bg-success-700 text-white rounded-lg hover:bg-success-800 text-sm font-medium disabled:opacity-50">
                <FileSpreadsheet className="h-4 w-4" /> Export Excel
              </button>
              <button onClick={handleExport} disabled={!report}
                className="inline-flex items-center gap-2 px-4 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium disabled:opacity-50">
                <Download className="h-4 w-4" /> Export CSV
              </button>
            </>
          }
        />

        {/* Full width: two grids side by side, each scrolling inside its own frame with the header
            row and the label column pinned. */}
        <div className="p-6 space-y-6">
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <DateField label="As at" value={asAtDate || null} onChange={(iso, v) => { if (v.valid) setAsAtDate(iso ?? ''); }} />
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
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Business Unit</label>
              <select value={businessUnitId} onChange={e => setBusinessUnitId(e.target.value)}
                className="ff-input text-sm min-w-[160px]">
                <option value="">All Business Units</option>
                {businessUnitId && !businessUnits.some(bu => bu.id === businessUnitId) && (
                  <option value={businessUnitId}>Selected Business Unit (unavailable)</option>
                )}
                {businessUnits.map(bu => (
                  <option key={bu.id} value={bu.id}>{bu.code} — {bu.name}</option>
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

          {Object.keys(refError).length > 0 && <p role="alert" className="text-xs text-amber-500">{Object.values(refError).join(' ')}</p>}
          {(error || periodError) && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error || periodError}
            </div>
          )}

          {isLoading ? (
            <ListSkeleton rows={14} label="Loading balance sheet" />
          ) : report ? (
            <>
            <p className="sm:hidden mb-1 text-xs text-[var(--ff-text-tertiary)]">Swipe the statement sideways for the prior period and variance columns.</p>
            <BalanceSheetBody
              returnTo={returnTo}
              costCentreId={costCentreId}
              businessUnitId={businessUnitId}
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
            </>
          ) : null}
        </div>
      </div>
      {evidenceTarget && (
        <EvidenceDrillModal
          costCentreId={costCentreId}
          businessUnitId={businessUnitId}
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
