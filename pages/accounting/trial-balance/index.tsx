/**
 * Trial Balance Page
 * Phase 5: Full trial balance with fiscal period selector + CSV export
 * Phase 5b: Cost centre filter + comparative period selector
 */

import React, { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Scale, Loader2, AlertCircle, Download, ChevronDown, ChevronRight } from 'lucide-react';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';
import { apiFetch } from '@/lib/apiFetch';

interface TBRow {
  accountCode: string; accountName: string; accountType: string;
  normalBalance: string; debitBalance: number; creditBalance: number;
  priorDebitBalance?: number; priorCreditBalance?: number;
}

interface CostCentre { id: string; code: string; name: string }

interface FiscalPeriod { id: string; periodName: string; startDate: string; endDate: string; status: string }

const fmt = (n: number) => new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(n);

export default function TrialBalancePage() {
  const [rows, setRows] = useState<TBRow[]>([]);
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

  // Load cost centres
  useEffect(() => {
    apiFetch('/api/accounting/cost-centres?active_only=true', { credentials: 'include' })
      .then(r => r.json())
      .then(json => setCostCentres(json.data?.items || json.data || []))
      .catch(() => { /* reference data load failure — non-critical, cost centre filter will be empty */ });
  }, []);

  // Load fiscal periods
  useEffect(() => {
    apiFetch('/api/accounting/fiscal-periods', { credentials: 'include' })
      .then(r => r.json())
      .then(res => {
        const items = res.data?.items || res.data || [];
        setPeriods(items);
        const open = items.find((p: FiscalPeriod) => p.status === 'open');
        if (open) setSelectedPeriod(open.id);
        else if (items.length > 0) setSelectedPeriod(items[0].id);
      });
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

  useEffect(() => { loadTB(); }, [loadTB]);

  const handleExport = () => {
    if (!selectedPeriod) return;
    window.open(`/api/accounting/trial-balance-export?fiscal_period_id=${selectedPeriod}`, '_blank');
  };

  const balanced = Math.abs(totalDebit - totalCredit) < 0.02;

  const selectedPeriodObj = periods.find(p => p.id === selectedPeriod);
  const todayStr: string = new Date().toISOString().substring(0, 10);
  const drillDownStart: string = selectedPeriodObj?.startDate
    ? selectedPeriodObj.startDate.substring(0, 10)
    : todayStr.substring(0, 4) + '-01-01';
  const drillDownEnd: string = selectedPeriodObj?.endDate
    ? selectedPeriodObj.endDate.substring(0, 10)
    : todayStr;

  const selectClass = 'px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm';

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
              {/* Primary period */}
              <select value={selectedPeriod} onChange={e => setSelectedPeriod(e.target.value)} className={selectClass}>
                {periods.map(p => (
                  <option key={p.id} value={p.id}>{p.periodName} ({p.status})</option>
                ))}
              </select>
              {/* Comparative period */}
              <select value={comparePeriodId} onChange={e => setComparePeriodId(e.target.value)} className={selectClass}>
                <option value="">No comparison</option>
                {periods.filter(p => p.id !== selectedPeriod).map(p => (
                  <option key={p.id} value={p.id}>{p.periodName}</option>
                ))}
              </select>
              {/* Cost centre filter */}
              <select value={costCentreId} onChange={e => setCostCentreId(e.target.value)} className={selectClass}>
                <option value="">All Cost Centres</option>
                {costCentres.map(cc => (
                  <option key={cc.id} value={cc.id}>{cc.code} — {cc.name}</option>
                ))}
              </select>
              <button onClick={handleExport} disabled={rows.length === 0}
                className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 text-sm font-medium disabled:opacity-50">
                <Download className="h-4 w-4" /> Export CSV
              </button>
            </div>
          </div>
        </div>

        <div className="p-6">
          {/* Balance status cards */}
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
                <p className={`text-xl font-bold ${balanced ? 'text-teal-400' : 'text-red-400'}`}>
                  {fmt(Math.abs(totalDebit - totalCredit))}
                  <span className="text-sm ml-2">{balanced ? 'Balanced' : 'Out of Balance'}</span>
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
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <React.Fragment key={r.accountCode}>
                      <tr
                        onClick={() => setExpandedAccount(expandedAccount === r.accountCode ? null : r.accountCode)}
                        className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50 cursor-pointer"
                      >
                        <td className="px-4 py-3 font-mono text-[var(--ff-text-tertiary)]">
                          <span className="flex items-center gap-1">
                            {expandedAccount === r.accountCode
                              ? <ChevronDown className="h-3 w-3" />
                              : <ChevronRight className="h-3 w-3" />}
                            {r.accountCode}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-[var(--ff-text-primary)]">{r.accountName}</td>
                        <td className="px-4 py-3"><span className="px-2 py-0.5 rounded text-xs bg-[var(--ff-bg-primary)] text-[var(--ff-text-secondary)]">{r.accountType}</span></td>
                        <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{r.debitBalance > 0 ? fmt(r.debitBalance) : '—'}</td>
                        <td className="px-4 py-3 text-right text-[var(--ff-text-primary)]">{r.creditBalance > 0 ? fmt(r.creditBalance) : '—'}</td>
                        {comparePeriodId && (
                          <>
                            <td className="px-4 py-3 text-right text-[var(--ff-text-tertiary)] text-xs">
                              {(r.priorDebitBalance ?? 0) > 0 ? fmt(r.priorDebitBalance ?? 0) : '—'}
                            </td>
                            <td className="px-4 py-3 text-right text-[var(--ff-text-tertiary)] text-xs">
                              {(r.priorCreditBalance ?? 0) > 0 ? fmt(r.priorCreditBalance ?? 0) : '—'}
                            </td>
                          </>
                        )}
                      </tr>
                      {expandedAccount === r.accountCode && (
                        <AccountDrillDown
                          accountCode={r.accountCode}
                          periodStart={drillDownStart}
                          periodEnd={drillDownEnd}
                          asTableRow
                          colSpan={comparePeriodId ? 7 : 5}
                        />
                      )}
                    </React.Fragment>
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
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
