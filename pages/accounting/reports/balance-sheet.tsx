/**
 * Balance Sheet Report Page
 * PRD-060 Phase 5: Assets, Liabilities, Equity
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, BarChart3, Loader2, AlertCircle, CheckCircle2, ChevronDown, ChevronRight, Download } from 'lucide-react';
import type { BalanceSheetReport } from '@/modules/accounting/types/gl.types';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface CostCentre { id: string; code: string; name: string }

export default function BalanceSheetPage() {
  const [asAtDate, setAsAtDate] = useState(new Date().toISOString().split('T')[0]);
  const [report, setReport] = useState<BalanceSheetReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);
  const [costCentres, setCostCentres] = useState<CostCentre[]>([]);
  const [costCentreId, setCostCentreId] = useState('');
  const [showComparative, setShowComparative] = useState(false);

  useEffect(() => {
    apiFetch('/api/accounting/cost-centres?active_only=true', { credentials: 'include' })
      .then(r => r.json())
      .then(json => setCostCentres(json.data?.items || json.data || []))
      .catch(() => { /* reference data load failure — non-critical, cost centre filter will be empty */ });
  }, []);

  const loadReport = useCallback(async () => {
    if (!asAtDate) return;
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ as_at_date: asAtDate });
      if (costCentreId) params.set('cost_centre_id', costCentreId);
      if (showComparative) {
        const d = new Date(asAtDate);
        d.setFullYear(d.getFullYear() - 1);
        params.set('compare_date', d.toISOString().slice(0, 10));
      }
      const res = await apiFetch(`/api/accounting/reports-balance-sheet?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load');
      setReport(json.data || json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load balance sheet');
    } finally {
      setIsLoading(false);
    }
  }, [asAtDate, costCentreId, showComparative]);

  useEffect(() => { loadReport(); }, [loadReport]);

  function handleExport() {
    if (!asAtDate) return;
    const params = new URLSearchParams({ as_at_date: asAtDate });
    if (costCentreId) params.set('cost_centre_id', costCentreId);
    window.open(`/api/accounting/balance-sheet-export?${params}`, '_blank');
  }

  const balanced = report ? Math.abs(report.totalAssets - (report.totalLiabilities + report.totalEquity)) < 0.02 : false;
  const drillDownStart = (asAtDate ?? '').slice(0, 4) + '-01-01';
  const drillDownEnd = asAtDate ?? '';

  // Shared comparative column header for section panels
  const compHeader = showComparative ? (
    <span className="flex items-center gap-3 text-xs text-[var(--ff-text-tertiary)] ml-auto">
      <span className="w-24 text-right">Prior</span>
      <span className="w-24 text-right">Current</span>
      <span className="w-20 text-right">Variance</span>
    </span>
  ) : <span className="text-xs text-[var(--ff-text-tertiary)] ml-auto">Click to drill down</span>;

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
              <button onClick={handleExport} disabled={!report}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50">
                <Download className="h-4 w-4" /> Export CSV
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-4xl space-y-6">
          {/* Filters */}
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">As at</label>
              <input type="date" value={asAtDate} onChange={e => setAsAtDate(e.target.value)} className="ff-input text-sm" />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">Cost Centre</label>
              <select value={costCentreId} onChange={e => setCostCentreId(e.target.value)}
                className="ff-input text-sm min-w-[160px]">
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
                      <div key={a.accountCode}>
                        <button onClick={() => setExpandedAccount(expandedAccount === a.accountCode ? null : a.accountCode)}
                          className="w-full px-6 py-2 flex justify-between text-sm hover:bg-[var(--ff-bg-tertiary)] cursor-pointer">
                          <span className="flex items-center gap-1 text-[var(--ff-text-secondary)]">
                            {expandedAccount === a.accountCode ? <ChevronDown className="h-3 w-3 text-[var(--ff-text-tertiary)]" /> : <ChevronRight className="h-3 w-3 text-[var(--ff-text-tertiary)]" />}
                            <span className="font-mono text-xs mr-2">{a.accountCode}</span>{a.accountName}
                          </span>
                          {showComparative && a.priorBalance !== undefined ? (
                            <span className="flex items-center gap-3">
                              <span className="font-mono text-[var(--ff-text-tertiary)] text-xs w-24 text-right">{formatCurrency(a.priorBalance)}</span>
                              <span className="font-mono text-[var(--ff-text-primary)] w-24 text-right">{formatCurrency(a.balance)}</span>
                              <span className={`font-mono text-xs w-20 text-right ${(a.variance ?? 0) >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                                {(a.variance ?? 0) >= 0 ? '+' : ''}{formatCurrency(a.variance ?? 0)}
                              </span>
                            </span>
                          ) : (
                            <span className="font-mono text-[var(--ff-text-primary)]">{formatCurrency(a.balance)}</span>
                          )}
                        </button>
                        {expandedAccount === a.accountCode && (
                          <AccountDrillDown accountCode={a.accountCode} periodStart={drillDownStart} periodEnd={drillDownEnd} />
                        )}
                      </div>
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
                  {/* Liabilities */}
                  <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
                    <div className="px-6 py-3 border-b border-[var(--ff-border-light)] bg-amber-500/5 flex items-center">
                      <h3 className="font-semibold text-amber-400">Liabilities</h3>
                      {compHeader}
                    </div>
                    <div className="divide-y divide-[var(--ff-border-light)]">
                      {report.liabilities.map(l => (
                        <div key={l.accountCode}>
                          <button onClick={() => setExpandedAccount(expandedAccount === l.accountCode ? null : l.accountCode)}
                            className="w-full px-6 py-2 flex justify-between text-sm hover:bg-[var(--ff-bg-tertiary)] cursor-pointer">
                            <span className="flex items-center gap-1 text-[var(--ff-text-secondary)]">
                              {expandedAccount === l.accountCode ? <ChevronDown className="h-3 w-3 text-[var(--ff-text-tertiary)]" /> : <ChevronRight className="h-3 w-3 text-[var(--ff-text-tertiary)]" />}
                              <span className="font-mono text-xs mr-2">{l.accountCode}</span>{l.accountName}
                            </span>
                            {showComparative && l.priorBalance !== undefined ? (
                              <span className="flex items-center gap-3">
                                <span className="font-mono text-[var(--ff-text-tertiary)] text-xs w-24 text-right">{formatCurrency(l.priorBalance)}</span>
                                <span className="font-mono text-[var(--ff-text-primary)] w-24 text-right">{formatCurrency(l.balance)}</span>
                                <span className={`font-mono text-xs w-20 text-right ${(l.variance ?? 0) >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                                  {(l.variance ?? 0) >= 0 ? '+' : ''}{formatCurrency(l.variance ?? 0)}
                                </span>
                              </span>
                            ) : (
                              <span className="font-mono text-[var(--ff-text-primary)]">{formatCurrency(l.balance)}</span>
                            )}
                          </button>
                          {expandedAccount === l.accountCode && (
                            <AccountDrillDown accountCode={l.accountCode} periodStart={drillDownStart} periodEnd={drillDownEnd} />
                          )}
                        </div>
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

                  {/* Equity */}
                  <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
                    <div className="px-6 py-3 border-b border-[var(--ff-border-light)] bg-purple-500/5 flex items-center">
                      <h3 className="font-semibold text-purple-400">Equity</h3>
                      {compHeader}
                    </div>
                    <div className="divide-y divide-[var(--ff-border-light)]">
                      {report.equity.map(e => (
                        <div key={e.accountCode}>
                          <button onClick={() => setExpandedAccount(expandedAccount === e.accountCode ? null : e.accountCode)}
                            className="w-full px-6 py-2 flex justify-between text-sm hover:bg-[var(--ff-bg-tertiary)] cursor-pointer">
                            <span className="flex items-center gap-1 text-[var(--ff-text-secondary)]">
                              {expandedAccount === e.accountCode ? <ChevronDown className="h-3 w-3 text-[var(--ff-text-tertiary)]" /> : <ChevronRight className="h-3 w-3 text-[var(--ff-text-tertiary)]" />}
                              <span className="font-mono text-xs mr-2">{e.accountCode}</span>{e.accountName}
                            </span>
                            {showComparative && e.priorBalance !== undefined ? (
                              <span className="flex items-center gap-3">
                                <span className="font-mono text-[var(--ff-text-tertiary)] text-xs w-24 text-right">{formatCurrency(e.priorBalance)}</span>
                                <span className="font-mono text-[var(--ff-text-primary)] w-24 text-right">{formatCurrency(e.balance)}</span>
                                <span className={`font-mono text-xs w-20 text-right ${(e.variance ?? 0) >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                                  {(e.variance ?? 0) >= 0 ? '+' : ''}{formatCurrency(e.variance ?? 0)}
                                </span>
                              </span>
                            ) : (
                              <span className="font-mono text-[var(--ff-text-primary)]">{formatCurrency(e.balance)}</span>
                            )}
                          </button>
                          {expandedAccount === e.accountCode && (
                            <AccountDrillDown accountCode={e.accountCode} periodStart={drillDownStart} periodEnd={drillDownEnd} />
                          )}
                        </div>
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

                  {/* L + E Total */}
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
    </AppLayout>
  );
}
