/**
 * Income Statement (P&L) Report Page
 * PRD-060 Phase 5: Revenue, Cost of Sales, Operating Expenses
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import Link from 'next/link';
import { ArrowLeft, BarChart3, Loader2, AlertCircle, ChevronDown, ChevronRight, Download } from 'lucide-react';
import type { IncomeStatementReport, IncomeStatementLineItem } from '@/modules/accounting/types/gl.types';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';

interface CostCentre { id: string; code: string; name: string }

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-ZA', { style: 'currency', currency: 'ZAR' }).format(amount);
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
  const defaults = getDefaultDates();
  const [periodStart, setPeriodStart] = useState(defaults.periodStart);
  const [periodEnd, setPeriodEnd] = useState(defaults.periodEnd);
  const [report, setReport] = useState<IncomeStatementReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);
  const [costCentres, setCostCentres] = useState<CostCentre[]>([]);
  const [costCentreId, setCostCentreId] = useState('');
  const [showComparative, setShowComparative] = useState(false);

  useEffect(() => {
    fetch('/api/accounting/cost-centres?active_only=true', { credentials: 'include' })
      .then(r => r.json())
      .then(json => setCostCentres(json.data?.items || json.data || []))
      .catch(() => {});
  }, []);

  function handleExport() {
    const params = new URLSearchParams({ period_start: periodStart, period_end: periodEnd });
    if (costCentreId) params.set('cost_centre_id', costCentreId);
    window.open(`/api/accounting/income-statement-export?${params}`, '_blank');
  }

  function toggleAccount(code: string) {
    setExpandedAccount(prev => (prev === code ? null : code));
  }

  const loadReport = useCallback(async () => {
    if (!periodStart || !periodEnd) return;
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
      const res = await fetch(`/api/accounting/reports-income-statement?${params}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || 'Failed to load');
      setReport(json.data || json);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load income statement');
    } finally {
      setIsLoading(false);
    }
  }, [periodStart, periodEnd, costCentreId, showComparative]);

  useEffect(() => { loadReport(); }, [loadReport]);

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
                <div className="p-2 rounded-lg bg-emerald-500/10">
                  <BarChart3 className="h-6 w-6 text-emerald-500" />
                </div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Income Statement</h1>
              </div>
              <button onClick={handleExport} disabled={!report}
                className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 text-sm font-medium disabled:opacity-50">
                <Download className="h-4 w-4" /> Export CSV
              </button>
            </div>
          </div>
        </div>

        <div className="p-6 max-w-4xl space-y-6">
          {/* Date Range + Filters */}
          <div className="flex flex-wrap items-end gap-4">
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">From</label>
              <input type="date" value={periodStart} onChange={e => setPeriodStart(e.target.value)} className="ff-input text-sm" />
            </div>
            <div>
              <label className="block text-xs text-[var(--ff-text-tertiary)] mb-1">To</label>
              <input type="date" value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} className="ff-input text-sm" />
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
              Compare prior period
            </label>
          </div>

          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
              <AlertCircle className="h-4 w-4" /> {error}
            </div>
          )}

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-emerald-500" />
            </div>
          ) : report ? (
            <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
              <div className="px-6 py-4 border-b border-[var(--ff-border-light)]">
                <h2 className="text-lg font-semibold text-[var(--ff-text-primary)]">
                  Profit &amp; Loss — {periodStart} to {periodEnd}
                </h2>
              </div>

              <div className="divide-y divide-[var(--ff-border-light)]">
                {/* Revenue */}
                <Section label="Revenue" items={report.revenue} total={report.totalRevenue} color="emerald"
                  periodStart={periodStart} periodEnd={periodEnd} expandedAccount={expandedAccount}
                  onToggleAccount={toggleAccount} showComparative={showComparative} />

                {/* Cost of Sales */}
                {report.costOfSales.length > 0 && (
                  <Section label="Cost of Sales" items={report.costOfSales} total={report.totalCostOfSales} color="orange"
                    periodStart={periodStart} periodEnd={periodEnd} expandedAccount={expandedAccount}
                    onToggleAccount={toggleAccount} showComparative={showComparative} />
                )}

                {/* Gross Profit */}
                <div className="px-6 py-3 flex justify-between bg-emerald-500/5">
                  <span className="font-semibold text-[var(--ff-text-primary)]">Gross Profit</span>
                  <span className={`font-bold font-mono ${report.grossProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {formatCurrency(report.grossProfit)}
                    {showComparative && report.priorGrossProfit !== undefined && (
                      <span className="text-xs text-[var(--ff-text-tertiary)] ml-2">
                        (prior: {formatCurrency(report.priorGrossProfit)})
                      </span>
                    )}
                  </span>
                </div>

                {/* Operating Expenses */}
                <Section label="Operating Expenses" items={report.operatingExpenses} total={report.totalOperatingExpenses} color="red"
                  periodStart={periodStart} periodEnd={periodEnd} expandedAccount={expandedAccount}
                  onToggleAccount={toggleAccount} showComparative={showComparative} />

                {/* Net Profit */}
                <div className="px-6 py-4 flex justify-between bg-[var(--ff-bg-primary)]">
                  <span className="text-lg font-bold text-[var(--ff-text-primary)]">Net Profit / (Loss)</span>
                  <span className={`text-xl font-bold font-mono ${report.netProfit >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {formatCurrency(report.netProfit)}
                    {showComparative && report.priorNetProfit !== undefined && (
                      <span className="text-xs text-[var(--ff-text-tertiary)] ml-2">
                        (prior: {formatCurrency(report.priorNetProfit)})
                      </span>
                    )}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </AppLayout>
  );
}

function Section({ label, items, total, color, periodStart, periodEnd, expandedAccount, onToggleAccount, showComparative }: {
  label: string;
  items: IncomeStatementLineItem[];
  total: number;
  color: string;
  periodStart: string;
  periodEnd: string;
  expandedAccount: string | null;
  onToggleAccount: (code: string) => void;
  showComparative: boolean;
}) {
  return (
    <div>
      <div className={`px-6 py-2 bg-${color}-500/5 flex items-center`}>
        <span className={`text-sm font-semibold text-${color}-400`}>{label}</span>
        {showComparative ? (
          <span className="flex items-center gap-4 text-xs text-[var(--ff-text-tertiary)] ml-auto">
            <span className="w-28 text-right">Prior</span>
            <span className="w-28 text-right">Current</span>
            <span className="w-20 text-right">Variance</span>
          </span>
        ) : (
          <span className="text-xs text-[var(--ff-text-tertiary)] ml-auto">Click account to expand</span>
        )}
      </div>
      {items.map(item => {
        const isExpanded = expandedAccount === item.accountCode;
        return (
          <div key={item.accountCode}>
            <button
              type="button"
              onClick={() => onToggleAccount(item.accountCode)}
              className="w-full px-6 py-2 flex justify-between items-center text-sm hover:bg-[var(--ff-bg-tertiary)] cursor-pointer text-left"
            >
              <span className="flex items-center gap-1 text-[var(--ff-text-secondary)] flex-1">
                {isExpanded
                  ? <ChevronDown className="h-3 w-3 shrink-0 text-[var(--ff-text-tertiary)]" />
                  : <ChevronRight className="h-3 w-3 shrink-0 text-[var(--ff-text-tertiary)]" />}
                <span className="font-mono text-xs mr-1">{item.accountCode}</span>
                {item.accountName}
              </span>
              {showComparative && item.priorAmount !== undefined ? (
                <span className="flex items-center gap-4">
                  <span className="font-mono text-[var(--ff-text-tertiary)] w-28 text-right text-xs">{formatCurrency(item.priorAmount)}</span>
                  <span className="font-mono text-[var(--ff-text-primary)] w-28 text-right">{formatCurrency(item.amount)}</span>
                  <span className={`font-mono w-20 text-right text-xs ${(item.variance ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {(item.variance ?? 0) >= 0 ? '+' : ''}{formatCurrency(item.variance ?? 0)}
                  </span>
                </span>
              ) : (
                <span className="font-mono text-[var(--ff-text-primary)]">{formatCurrency(item.amount)}</span>
              )}
            </button>
            {isExpanded && (
              <div className="px-6 pb-3">
                <AccountDrillDown accountCode={item.accountCode} periodStart={periodStart} periodEnd={periodEnd} />
              </div>
            )}
          </div>
        );
      })}
      {items.length === 0 && (
        <div className="px-6 py-2 text-sm text-[var(--ff-text-tertiary)]">No entries</div>
      )}
      <div className="px-6 py-2 flex justify-between border-t border-[var(--ff-border-light)]">
        <span className="text-sm font-medium text-[var(--ff-text-primary)]">Total {label}</span>
        <span className="font-mono font-medium text-[var(--ff-text-primary)]">{formatCurrency(total)}</span>
      </div>
    </div>
  );
}
