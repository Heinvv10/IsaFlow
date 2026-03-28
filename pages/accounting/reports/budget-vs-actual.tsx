/**
 * Budget vs Actual Report
 * Sage equivalent: Reports > Budget vs Actual
 * Compare budgeted amounts per GL account against actual GL balances
 */

import React, { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';
import { BarChart3, Loader2, AlertCircle, Download, ChevronDown, ChevronRight } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';
import { apiFetch } from '@/lib/apiFetch';

interface BudgetLine {
  account_code: string;
  account_name: string;
  account_type: string;
  budget_amount: number;
  actual_amount: number;
  variance: number;
  variance_pct: number;
}

interface BudgetReport {
  period: string;
  lines: BudgetLine[];
  total_budget: number;
  total_actual: number;
  total_variance: number;
}

function getDrillDownDates(period: string): { start: string; end: string } {
  const now = new Date();
  const year = now.getFullYear();
  const todayStr = now.toISOString().split('T')[0] ?? `${year}-01-01`;
  if (period === 'ytd') return { start: `${year}-01-01`, end: todayStr };
  if (period === 'full_year') return { start: `${year}-01-01`, end: `${year}-12-31` };
  // current period = current month
  const monthStart = new Date(year, now.getMonth(), 1);
  const monthStartStr = monthStart.toISOString().split('T')[0] ?? `${year}-01-01`;
  return { start: monthStartStr, end: todayStr };
}

export default function BudgetVsActualPage() {
  const [report, setReport] = useState<BudgetReport | null>(null);
  const [fiscalPeriod, setFiscalPeriod] = useState('current');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);

  const drillDates = getDrillDownDates(fiscalPeriod);

  const loadReport = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ period: fiscalPeriod });
      const res = await apiFetch(`/api/accounting/reports-budget-vs-actual?${params}`);
      const json = await res.json();
      const data = json.data || json;
      setReport(data.report || data);
    } catch {
      setError('Failed to load budget report');
    } finally {
      setIsLoading(false);
    }
  }, [fiscalPeriod]);

  useEffect(() => { loadReport(); }, [loadReport]);

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-6 py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-violet-500/10">
                  <BarChart3 className="h-6 w-6 text-violet-500" />
                </div>
                <div>
                  <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Budget vs Actual</h1>
                  <p className="text-sm text-[var(--ff-text-secondary)]">
                    Compare budgeted and actual amounts by GL account
                  </p>
                </div>
              </div>
              <button onClick={() => {
                const params = new URLSearchParams({ period: fiscalPeriod });
                window.open(`/api/accounting/budget-vs-actual-export?${params}`, '_blank');
              }} disabled={!report || !report.lines || report.lines.length === 0}
                className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-lg flex items-center gap-2 text-sm font-medium disabled:opacity-50">
                <Download className="h-4 w-4" /> Export CSV
              </button>
            </div>
          </div>
        </div>

        <div className="p-6">
          <div className="flex items-center gap-4 mb-6">
            <select
              value={fiscalPeriod}
              onChange={(e) => setFiscalPeriod(e.target.value)}
              className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
            >
              <option value="current">Current Period</option>
              <option value="ytd">Year to Date</option>
              <option value="full_year">Full Year</option>
            </select>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-violet-500" />
            </div>
          ) : error ? (
            <div className="flex items-center gap-2 text-red-400 py-8 justify-center">
              <AlertCircle className="h-5 w-5" />
              <span>{error}</span>
            </div>
          ) : !report || !report.lines || report.lines.length === 0 ? (
            <div className="text-center py-12">
              <BarChart3 className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)]">No budget data available</p>
              <p className="text-sm text-[var(--ff-text-tertiary)] mt-1">
                Set budgets per GL account to see variance analysis
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Account</th>
                    <th className="text-left py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Name</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Budget</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Actual</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">Variance</th>
                    <th className="text-right py-3 px-4 text-[var(--ff-text-secondary)] font-medium">%</th>
                    <th className="py-3 px-4 text-[var(--ff-text-secondary)] font-medium w-32">Bar</th>
                  </tr>
                </thead>
                <tbody>
                  {report.lines.map((line) => {
                    const pct = line.budget_amount > 0 ? (line.actual_amount / line.budget_amount) * 100 : 0;
                    return (
                      <React.Fragment key={line.account_code}>
                        <tr
                          onClick={() => setExpandedAccount(expandedAccount === line.account_code ? null : line.account_code)}
                          className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-tertiary)] cursor-pointer"
                        >
                          <td className="py-3 px-4 font-mono text-[var(--ff-text-tertiary)]">
                            <span className="flex items-center gap-1">
                              {expandedAccount === line.account_code
                                ? <ChevronDown className="h-3 w-3" />
                                : <ChevronRight className="h-3 w-3" />}
                              {line.account_code}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-[var(--ff-text-primary)]">{line.account_name}</td>
                          <td className="py-3 px-4 text-right text-[var(--ff-text-secondary)]">{formatCurrency(line.budget_amount)}</td>
                          <td className="py-3 px-4 text-right text-[var(--ff-text-primary)]">{formatCurrency(line.actual_amount)}</td>
                          <td className={`py-3 px-4 text-right font-medium ${line.variance >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                            {formatCurrency(line.variance)}
                          </td>
                          <td className={`py-3 px-4 text-right text-xs ${line.variance_pct >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                            {line.variance_pct.toFixed(1)}%
                          </td>
                          <td className="py-3 px-4">
                            <div className="w-full h-2 bg-[var(--ff-bg-tertiary)] rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${pct > 100 ? 'bg-red-500' : pct > 80 ? 'bg-amber-500' : 'bg-teal-500'}`}
                                style={{ width: `${Math.min(pct, 100)}%` }}
                              />
                            </div>
                          </td>
                        </tr>
                        {expandedAccount === line.account_code && (
                          <AccountDrillDown
                            accountCode={line.account_code}
                            periodStart={drillDates.start}
                            periodEnd={drillDates.end}
                            asTableRow
                            colSpan={7}
                          />
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-[var(--ff-border-light)] font-bold">
                    <td colSpan={2} className="py-3 px-4 text-[var(--ff-text-primary)]">Total</td>
                    <td className="py-3 px-4 text-right text-[var(--ff-text-primary)]">{formatCurrency(report.total_budget)}</td>
                    <td className="py-3 px-4 text-right text-[var(--ff-text-primary)]">{formatCurrency(report.total_actual)}</td>
                    <td className={`py-3 px-4 text-right ${report.total_variance >= 0 ? 'text-teal-400' : 'text-red-400'}`}>
                      {formatCurrency(report.total_variance)}
                    </td>
                    <td colSpan={2}></td>
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
