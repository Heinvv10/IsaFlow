/**
 * Trial Balance Page
 * Phase 5: Full trial balance with fiscal period selector + CSV export
 * Phase 5b: Cost centre filter + comparative period selector
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Scale, Loader2, AlertCircle, Download, CheckCircle2, AlertTriangle } from 'lucide-react';
import { TrialBalanceRow } from '@/components/reports/TrialBalanceRow';
import type { TBRowData } from '@/components/reports/TrialBalanceRow';
import { EvidenceDrillModal } from '@/components/accounting/evidence/EvidenceDrillModal';
import { apiFetch } from '@/lib/apiFetch';

interface CostCentre { id: string; code: string; name: string }
interface FiscalPeriod { id: string; periodName: string; startDate: string; endDate: string; status: string }
interface EvidenceTarget { accountId: string; accountName: string }

const fmt = (n: number) =>
  new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export default function TrialBalancePage() {
  const [rows, setRows] = useState<TBRowData[]>([]);
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [selectedPeriod, setSelectedPeriod] = useState('');
  const [totalDebit, setTotalDebit] = useState(0);
  const [totalCredit, setTotalCredit] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);
  const [costCentres, setCostCentres] = useState<CostCentre[]>([]);
  const [costCentreId, setCostCentreId] = useState('');
  const [comparePeriodId, setComparePeriodId] = useState('');
  const [evidenceTarget, setEvidenceTarget] = useState<EvidenceTarget | null>(null);

  useEffect(() => {
    apiFetch('/api/accounting/cost-centres?active_only=true', { credentials: 'include' })
      .then(r => r.json())
      .then(json => setCostCentres(json.data?.items || json.data || []))
      .catch(() => { /* reference data load failure — non-critical */ });
  }, []);

  useEffect(() => {
    const todayIso = new Date().toISOString().substring(0, 10);
    apiFetch('/api/accounting/fiscal-periods', { credentials: 'include' })
      .then(r => r.json())
      .then(res => {
        const items: FiscalPeriod[] = res.data?.items || res.data || [];
        setPeriods(items);
        const openContainingToday = items.find(
          p => p.status === 'open'
            && p.startDate.substring(0, 10) <= todayIso
            && p.endDate.substring(0, 10) >= todayIso,
        );
        const anyOpen = items.find(p => p.status === 'open');
        const best = openContainingToday ?? anyOpen;
        if (best) setSelectedPeriod(best.id);
        else if (items.length > 0) setSelectedPeriod(items[0]!.id);
      })
      .catch(() => { /* non-critical — period selector remains empty */ });
  }, []);

  const loadTB = useCallback(async () => {
    if (!selectedPeriod) return;
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ fiscal_period_id: selectedPeriod });
      if (costCentreId) params.set('cost_centre_id', costCentreId);
      if (comparePeriodId) params.set('compare_period_id', comparePeriodId);
      const res = await apiFetch(`/api/accounting/reports-trial-balance?${params}`, { credentials: 'include' });
      if (!res.ok) throw new Error('Failed to load');
      const json = await res.json();
      const data = json.data || json;
      setRows(data.rows || []);
      setTotalDebit(Number(data.totalDebit || 0));
      setTotalCredit(Number(data.totalCredit || 0));
    } catch { setError('Failed to load trial balance'); }
    finally { setLoading(false); }
  }, [selectedPeriod, costCentreId, comparePeriodId]);

  useEffect(() => { void loadTB(); }, [loadTB]);

  const handleExport = () => {
    if (selectedPeriod) window.open(`/api/accounting/trial-balance-export?fiscal_period_id=${selectedPeriod}`, '_blank');
  };

  const balanced = Math.abs(totalDebit - totalCredit) < 0.02;

  const selectedPeriodObj = periods.find(p => p.id === selectedPeriod);
  const todayStr = new Date().toISOString().substring(0, 10);
  const drillDownStart = selectedPeriodObj?.startDate
    ? selectedPeriodObj.startDate.substring(0, 10)
    : todayStr.substring(0, 4) + '-01-01';
  const drillDownEnd = selectedPeriodObj?.endDate
    ? selectedPeriodObj.endDate.substring(0, 10)
    : todayStr;

  const selectClass = 'px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm';
  const colSpan = comparePeriodId ? 7 : 5;

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-indigo-500/10"><Scale className="h-6 w-6 text-indigo-500" /></div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Trial Balance</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">Account balances for selected fiscal period — Click any account to drill down</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
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
              <button onClick={handleExport} disabled={rows.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 text-sm font-medium disabled:opacity-50">
                <Download className="h-4 w-4" /> Export CSV
              </button>
            </div>
          </div>
        </div>

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
                  {fmt(Math.abs(totalDebit - totalCredit))}
                  <span className="text-sm ml-1 font-normal">{balanced ? 'Balanced' : 'Out of Balance'}</span>
                </p>
              </div>
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-indigo-500" /></div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center"><AlertCircle className="h-5 w-5" /><span>{error}</span></div>
          ) : rows.length === 0 ? (
            <div className="text-center py-12">
              <Scale className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)]">No trial balance data</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">Select a fiscal period with posted journal entries</p>
            </div>
          ) : (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                    <th className="px-4 py-3">Code</th>
                    <th className="px-4 py-3">Account</th>
                    <th className="px-4 py-3">Type</th>
                    <th className="px-4 py-3 text-right">Debit</th>
                    <th className="px-4 py-3 text-right">Credit</th>
                    {comparePeriodId && (
                      <>
                        <th className="px-4 py-3 text-right text-[var(--ff-text-tertiary)]">Prior Dr</th>
                        <th className="px-4 py-3 text-right text-[var(--ff-text-tertiary)]">Prior Cr</th>
                      </>
                    )}
                    <th className="px-4 py-3 text-center text-[var(--ff-text-tertiary)]">Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <TrialBalanceRow
                      key={r.accountCode}
                      row={r}
                      isExpanded={expandedAccount === r.accountCode}
                      onToggle={code => setExpandedAccount(prev => prev === code ? null : code)}
                      onEvidence={(id, name) => setEvidenceTarget({ accountId: id, accountName: name })}
                      showComparative={!!comparePeriodId}
                      drillDownStart={drillDownStart}
                      drillDownEnd={drillDownEnd}
                      colSpan={colSpan}
                    />
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[var(--ff-border-light)] font-bold">
                    <td colSpan={3} className="px-4 py-3 text-[var(--ff-text-primary)]">TOTALS</td>
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
            </div>
          )}
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
