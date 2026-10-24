/**
 * Trial Balance Page
 * Phase 5: Full trial balance with fiscal period selector + CSV export
 * Phase 5b: Cost centre filter + comparative period selector
 * Phase 5c: Business unit filter across report, export and drill-through
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { PageHeader } from '@/components/ui/PageHeader';
import { STICKY_FIRST_HEAD, STICKY_HEAD, STICKY_WRAP } from '@/components/accounting/statement/stickyTable';
import { Scale, Loader2, AlertCircle, Download, CheckCircle2, AlertTriangle } from 'lucide-react';
import { TrialBalanceRow } from '@/components/reports/TrialBalanceRow';
import type { TBRowData } from '@/components/reports/TrialBalanceRow';
import { TrialBalanceYearEndNote } from '@/components/reports/TrialBalanceYearEndNote';
import { EvidenceDrillModal } from '@/components/accounting/evidence/EvidenceDrillModal';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';

import { useTrialBalanceFilters } from '@/components/reports/useTrialBalanceFilters';
import { localISODate } from '@/lib/dateUtils';
import { log } from '@/lib/logger';

interface CostCentre { id: string; code: string; name: string }
interface BusinessUnit { id: string; code: string; name: string }
interface EvidenceTarget { accountId: string; accountName: string }

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export default function TrialBalancePage() {
  const [rows, setRows] = useState<TBRowData[]>([]);
  const { periods, periodsError, selectedPeriod, setSelectedPeriod, costCentreId, setCostCentreId,
    businessUnitId, setBusinessUnitId, comparePeriodId, setComparePeriodId,
    showMovement, setShowMovement, returnTo, filtersReady } = useTrialBalanceFilters();
  const [totalDebit, setTotalDebit] = useState(0);
  const [totalCredit, setTotalCredit] = useState(0);
  // Authoritative, from the service. Recomputing these client-side is how a
  // partial trial balance came to be stamped "Difference R0.00 · Balanced".
  const [difference, setDifference] = useState(0);
  const [balanced, setBalanced] = useState(true);
  const [accountCount, setAccountCount] = useState(0);
  const [fiscalYearStart, setFiscalYearStart] = useState('');
  const [fiscalYearEnds, setFiscalYearEnds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);
  const [costCentres, setCostCentres] = useState<CostCentre[]>([]);
  const [businessUnits, setBusinessUnits] = useState<BusinessUnit[]>([]);
  const [evidenceTarget, setEvidenceTarget] = useState<EvidenceTarget | null>(null);

  useEffect(() => {
    apiFetch('/api/accounting/cost-centres?active_only=true', { credentials: 'include' })
      .then(async r => { await assertOk(r, 'Could not load the cost centres'); return r.json(); })
      .then(json => setCostCentres(json.data?.items || json.data || []))
      .catch(err => { setCostCentres([]); log.warn('Failed to load cost centres', { err }, 'trial-balance'); });
    apiFetch('/api/accounting/business-units?active=true', { credentials: 'include' })
      .then(async r => { await assertOk(r, 'Could not load the business units'); return r.json(); })
      .then(json => {
        const items = json.data?.items || json.data || [];
        setBusinessUnits(Array.isArray(items) ? items : []);
      })
      .catch(err => { setBusinessUnits([]); log.warn('Failed to load business units', { err }, 'trial-balance'); });
  }, []);

  const loadTB = useCallback(async () => {
    if (!selectedPeriod || !filtersReady) return;
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ fiscal_period_id: selectedPeriod });
      if (costCentreId) params.set('cost_centre_id', costCentreId);
      if (businessUnitId) params.set('business_unit_id', businessUnitId);
      if (comparePeriodId) params.set('compare_period_id', comparePeriodId);
      const res = await apiFetch(`/api/accounting/reports-trial-balance?${params}`, { credentials: 'include' });
      await assertOk(res, 'Could not load the trial balance - try again');
      const json = await res.json();
      const data = json.data || json;
      setRows(data.rows || []);
      setTotalDebit(Number(data.totalDebit || 0));
      setTotalCredit(Number(data.totalCredit || 0));
      setDifference(Number(data.difference || 0));
      setBalanced(data.balanced === true);
      setAccountCount(Number(data.accountCount || 0));
      setFiscalYearStart(String(data.fiscalYearStart || ''));
      setFiscalYearEnds(Array.isArray(data.fiscalYearEndsClosed) ? data.fiscalYearEndsClosed.map(String) : []);
    } catch (err) { setError(apiErrorMessage(err, 'Could not load the trial balance - try again')); }
    finally { setLoading(false); }
  }, [selectedPeriod, costCentreId, businessUnitId, comparePeriodId, filtersReady]);

  useEffect(() => { void loadTB(); }, [loadTB]);

  const handleExport = () => {
    if (!selectedPeriod || !filtersReady) return;
    const params = new URLSearchParams({ fiscal_period_id: selectedPeriod });
    if (costCentreId) params.set('cost_centre_id', costCentreId);
    if (businessUnitId) params.set('business_unit_id', businessUnitId);
    window.open(`/api/accounting/trial-balance-export?${params}`, '_blank');
  };

  const sumOf = (key: 'openingDebit' | 'openingCredit' | 'periodDebit' | 'periodCredit') =>
    rows.reduce((s, r) => s + (r[key] ?? 0), 0);

  const selectedPeriodObj = periods.find(p => p.id === selectedPeriod);
  const todayStr = localISODate();
  const drillDownStart = selectedPeriodObj?.startDate
    ? selectedPeriodObj.startDate.substring(0, 10)
    : todayStr.substring(0, 4) + '-01-01';
  const drillDownEnd = selectedPeriodObj?.endDate
    ? selectedPeriodObj.endDate.substring(0, 10)
    : todayStr;

  const selectClass = 'px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm';
  const colSpan = 5 + (comparePeriodId ? 2 : 0) + (showMovement ? 4 : 0);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <PageHeader
          icon={Scale}
          title="Trial Balance"
          subtitle="Balances as at the end of the selected period — balance-sheet accounts cumulative, income-statement accounts year-to-date. Click any account to drill down"
          chipColor="bg-indigo-500/10 text-indigo-700 dark:text-indigo-400"
          className="mb-0"
          actions={
            <>
              <select value={selectedPeriod} onChange={e => setSelectedPeriod(e.target.value)} className={selectClass}>
                {periods.map(p => (
                  <option key={p.id} value={p.id}>{p.periodName} ({p.status})</option>
                ))}
              </select>
              <select value={comparePeriodId} onChange={e => setComparePeriodId(e.target.value)} className={selectClass}>
                <option value="">No comparison</option>
                {periods.filter(p => p.id !== selectedPeriod).map(p => (
                  <option key={p.id} value={p.id}>{p.periodName}</option>
                ))}
              </select>
              <select value={costCentreId} onChange={e => setCostCentreId(e.target.value)} className={selectClass}>
                <option value="">All Cost Centres</option>
                {costCentres.map(cc => (
                  <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>
                ))}
              </select>
              <select value={businessUnitId} onChange={e => setBusinessUnitId(e.target.value)} className={selectClass}>
                <option value="">All Business Units</option>
                {businessUnitId && !businessUnits.some(bu => bu.id === businessUnitId) && (
                  <option value={businessUnitId}>Selected Business Unit (unavailable)</option>
                )}
                {businessUnits.map(bu => (
                  <option key={bu.id} value={bu.id}>{bu.code} — {bu.name}</option>
                ))}
              </select>
              <button
                onClick={() => setShowMovement(v => !v)}
                aria-pressed={showMovement}
                className={`px-4 py-2 rounded-lg border text-sm font-medium ${showMovement
                  ? 'border-indigo-500 bg-indigo-500/10 text-indigo-500'
                  : 'border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800'}`}
              >
                {showMovement ? 'Hide movement' : 'Show movement'}
              </button>
              <button onClick={handleExport} disabled={rows.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium disabled:opacity-50">
                <Download className="h-4 w-4" /> Export CSV
              </button>
            </>
          }
        />

        <div className="p-6">
          {!loading && rows.length > 0 && (
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Total Debits</p>
                <p className="text-xl font-bold text-[var(--ff-text-primary)]">{fmt(totalDebit)}</p>
              </div>
              <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-4">
                <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Total Credits</p>
                <p className="text-xl font-bold text-[var(--ff-text-primary)]">{fmt(totalCredit)}</p>
              </div>
              <div className={`rounded-lg border p-4 ${balanced ? 'bg-teal-500/5 border-teal-500/30' : 'bg-red-500/5 border-red-500/30'}`}>
                <p className="text-xs text-[var(--ff-text-tertiary)] mb-1">Difference</p>
                <p className={`text-xl font-bold flex items-center gap-1.5 ${balanced ? 'text-teal-700 dark:text-teal-400' : 'text-red-700 dark:text-red-400'}`}>
                  {balanced ? <CheckCircle2 className="h-5 w-5" aria-hidden="true" /> : <AlertTriangle className="h-5 w-5" aria-hidden="true" />}
                  {fmt(Math.abs(difference))}
                  <span className="text-sm ml-1 font-normal">{balanced ? 'Balanced' : 'Out of Balance'}</span>
                </p>
                <p className="text-[11px] text-[var(--ff-text-tertiary)] mt-1">
                  Across {accountCount} account{accountCount === 1 ? '' : 's'}
                  {fiscalYearStart && ` · income statement from ${fiscalYearStart}`}
                </p>
              </div>
            </div>
          )}

          {loading && !periodsError ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-indigo-500" /></div>
          ) : error || periodsError ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center"><AlertCircle className="h-5 w-5" /><span>{error || periodsError}</span></div>
          ) : rows.length === 0 ? (
            <div className="text-center py-12">
              <Scale className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)]">No trial balance data</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">Select a fiscal period with posted journal entries</p>
            </div>
          ) : (
            <div data-sticky-frame className={`bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] ${STICKY_WRAP}`}>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                    <th className={`px-4 py-3 w-28 min-w-[7rem] ${STICKY_FIRST_HEAD}`}>Code</th>
                    <th className={`px-4 py-3 sticky left-28 top-0 z-30 bg-[var(--ff-bg-secondary)] shadow-[inset_0_-1px_0_var(--ff-border-secondary)] print:static`}>Account</th>
                    <th className={`px-4 py-3 ${STICKY_HEAD}`}>Type</th>
                    {showMovement && (
                      <>
                        <th className={`px-4 py-3 text-right text-[var(--ff-text-tertiary)] ${STICKY_HEAD}`}>Opening Dr</th>
                        <th className={`px-4 py-3 text-right text-[var(--ff-text-tertiary)] ${STICKY_HEAD}`}>Opening Cr</th>
                        <th className={`px-4 py-3 text-right text-[var(--ff-text-tertiary)] ${STICKY_HEAD}`}>Movement Dr</th>
                        <th className={`px-4 py-3 text-right text-[var(--ff-text-tertiary)] ${STICKY_HEAD}`}>Movement Cr</th>
                      </>
                    )}
                    <th className={`px-4 py-3 text-right ${STICKY_HEAD}`}>Closing Dr</th>
                    <th className={`px-4 py-3 text-right ${STICKY_HEAD}`}>Closing Cr</th>
                    {comparePeriodId && (
                      <>
                        <th className={`px-4 py-3 text-right text-[var(--ff-text-tertiary)] ${STICKY_HEAD}`}>Prior Dr</th>
                        <th className={`px-4 py-3 text-right text-[var(--ff-text-tertiary)] ${STICKY_HEAD}`}>Prior Cr</th>
                      </>
                    )}
                    <th className={`px-4 py-3 text-center text-[var(--ff-text-tertiary)] ${STICKY_HEAD}`}>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <TrialBalanceRow
                      returnTo={returnTo}
                      costCentreId={costCentreId}
                      businessUnitId={businessUnitId}
                      key={r.accountCode}
                      row={r}
                      isExpanded={expandedAccount === r.accountCode}
                      onToggle={code => setExpandedAccount(prev => prev === code ? null : code)}
                      onEvidence={(id, name) => setEvidenceTarget({ accountId: id, accountName: name })}
                      showComparative={!!comparePeriodId}
                      showMovement={showMovement}
                      drillDownStart={drillDownStart}
                      drillDownEnd={drillDownEnd}
                      colSpan={colSpan}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[var(--ff-border-light)] font-bold">
                    <td colSpan={3} className="px-4 py-3 text-[var(--ff-text-primary)]">TOTALS</td>
                    {showMovement && (
                      <>
                        <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)] text-xs">{fmt(sumOf('openingDebit'))}</td>
                        <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)] text-xs">{fmt(sumOf('openingCredit'))}</td>
                        <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)] text-xs">{fmt(sumOf('periodDebit'))}</td>
                        <td className="px-4 py-3 text-right text-[var(--ff-text-secondary)] text-xs">{fmt(sumOf('periodCredit'))}</td>
                      </>
                    )}
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(totalDebit)}</td>
                    <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{fmt(totalCredit)}</td>
                    {comparePeriodId && (
                      <>
                        <td className="px-4 py-3 text-right text-[var(--ff-text-tertiary)] text-xs">
                          {fmt(rows.reduce((s, r) => s + (r.priorDebitBalance ?? 0), 0))}
                        </td>
                        <td className="px-4 py-3 text-right text-[var(--ff-text-tertiary)] text-xs">
                          {fmt(rows.reduce((s, r) => s + (r.priorCreditBalance ?? 0), 0))}
                        </td>
                      </>
                    )}
                    <td />
                  </tr>
                </tfoot>
              </table>
              <TrialBalanceYearEndNote fiscalYearEnds={fiscalYearEnds} broughtForwardClosed={rows.find(r => r.derived)?.closedToRetainedEarnings ?? 0} />
            </div>
          )}
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
