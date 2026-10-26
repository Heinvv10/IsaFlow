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
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { longDate, monthLabel, parseReportPeriod } from '@/components/accounting/budgets/budgetClient';

interface BudgetLine {
  account_code: string;
  account_name: string;
  account_type: string;
  budget_amount: number;
  actual_amount: number;
  variance: number;
  variance_pct: number;
}

interface ReportYear { fiscalYear: number; startDate: string; endDate: string; kind: string }

interface BudgetReport {
  period: string;
  lines: BudgetLine[];
  total_budget: number;
  total_actual: number;
  total_variance: number;
  /** Year to date of a chosen year that has not begun: nothing to show; `starts_on` is its first day. */
  not_started?: boolean;
  starts_on?: string;
}

/** The report's query string: the period, and the financial-year label when one is chosen. */
function reportQuery(period: string, year: number | null): string {
  const params = new URLSearchParams({ period });
  if (year !== null) params.set('fiscal_year', String(year));
  return params.toString();
}

export default function BudgetVsActualPage() {
  const [report, setReport] = useState<BudgetReport | null>(null);
  const [fiscalPeriod, setFiscalPeriod] = useState('current');
  // The financial year picked for year to date / full year; null = the year holding today.
  const [chosenYear, setChosenYear] = useState<number | null>(null);
  const [years, setYears] = useState<ReportYear[]>([]);
  const [shownYear, setShownYear] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);

  const selectedYear = chosenYear ?? shownYear;
  const yearOptions: Array<{ fiscalYear: number; startDate: string; endDate: string }> = years.length > 0
    ? years : selectedYear !== null ? [{ fiscalYear: selectedYear, startDate: '', endDate: '' }] : [];
  // The range the report itself covers, so a drill-down foots to its line.
  const range = parseReportPeriod(report?.period);

  // The current month has no year to choose; the other periods take the chosen one.
  const yearParam = fiscalPeriod !== 'current' && chosenYear !== null ? chosenYear : null;
  const loadReport = useCallback(async () => {
    setIsLoading(true);
    setError('');
    try {
      const res = await apiFetch(`/api/accounting/reports-budget-vs-actual?${reportQuery(fiscalPeriod, yearParam)}`);
      await assertOk(res, 'Could not load the budget report - try again');
      const json = await res.json();
      const data = json.data || json;
      setReport(data.report || data);
      setYears(data.years ?? []);
      setShownYear(data.fiscal_year ?? null);
    } catch (err) {
      setReport(null);
      setYears([]);
      setShownYear(null);
      setError(apiErrorMessage(err, 'Could not load the budget report - try again'));
    } finally {
      setIsLoading(false);
    }
  }, [fiscalPeriod, yearParam]);

  useEffect(() => { void loadReport(); }, [loadReport]);

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
                  {range && (
                    <p data-testid="report-period" className="text-xs text-[var(--ff-text-secondary)] mt-1">
                      {longDate(range.start)} to {longDate(range.end)}
                    </p>
                  )}
                </div>
              </div>
              <button onClick={() => {
                window.open(`/api/accounting/budget-vs-actual-export?${reportQuery(fiscalPeriod, yearParam)}`, '_blank');
              }} disabled={!report || !report.lines || report.lines.length === 0}
                className="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg flex items-center gap-2 text-sm font-medium disabled:opacity-50">
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
            {fiscalPeriod !== 'current' && (selectedYear !== null) && (
              <select
                value={selectedYear}
                onChange={(e) => setChosenYear(Number(e.target.value))}
                data-testid="report-year"
                className="px-3 py-2 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] text-sm"
              >
                {yearOptions.map(y => (
                  <option key={y.fiscalYear} value={y.fiscalYear}>
                    {y.startDate ? `${y.fiscalYear}: ${monthLabel(y.startDate.slice(0, 7))} - ${monthLabel(y.endDate.slice(0, 7))}` : y.fiscalYear}
                  </option>
                ))}
              </select>
            )}
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
              {report?.not_started && report.starts_on ? (
                <>
                  <p data-testid="year-not-started" className="text-[var(--ff-text-secondary)]">
                    This financial year starts on {longDate(report.starts_on)}
                  </p>
                  <p className="text-sm text-[var(--ff-text-secondary)] mt-1">
                    There is nothing to show for year to date yet; choose Full Year to see its budget.
                  </p>
                </>
              ) : (
                <>
                  <p className="text-[var(--ff-text-secondary)]">No budget data available</p>
                  <p className="text-sm text-[var(--ff-text-secondary)] mt-1">
                    Set budgets per GL account to see variance analysis
                  </p>
                </>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--ff-border-light)]">
                    <th className="text-left py-3 px-4 text-xs tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Account</th>
                    <th className="text-left py-3 px-4 text-xs tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Name</th>
                    <th className="text-right py-3 px-4 text-xs tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Budget</th>
                    <th className="text-right py-3 px-4 text-xs tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Actual</th>
                    <th className="text-right py-3 px-4 text-xs tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">Variance</th>
                    <th className="text-right py-3 px-4 text-xs tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase">%</th>
                    <th className="py-3 px-4 text-xs tracking-[0.12em] font-semibold text-[var(--ff-text-secondary)] uppercase w-32">Bar</th>
                  </tr>
                </thead>
                <tbody>
                  {report.lines.map((line) => {
                    const pct = line.budget_amount > 0 ? (line.actual_amount / line.budget_amount) * 100 : 0;
                    return (
                      <React.Fragment key={line.account_code}>
                        <tr
                          onClick={() => setExpandedAccount(expandedAccount === line.account_code ? null : line.account_code)}
                          className="border-b border-[var(--ff-border-light)] hover:bg-teal-500/[0.04] cursor-pointer"
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
                        {expandedAccount === line.account_code && range && (
                          <AccountDrillDown
                            accountCode={line.account_code}
                            periodStart={range.start}
                            periodEnd={range.end}
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
