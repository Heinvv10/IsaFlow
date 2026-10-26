/**
 * Budget vs Actual Report
 * Sage equivalent: Reports > Budget vs Actual
 * Compare budgeted amounts per GL account against actual GL balances, in
 * Revenue / Expenses / Net profit sections (BudgetVsActualTable). Opens on Year
 * to date, like the API; every window covers whole months on both sides.
 */

import { useState, useEffect, useCallback } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { BarChart3, Loader2, AlertCircle, Download } from 'lucide-react';
import { apiFetch, assertOk, apiErrorMessage } from '@/lib/apiFetch';
import { longDate, monthLabel, parseReportPeriod } from '@/components/accounting/budgets/budgetClient';
import { BudgetVsActualTable, type BvaLine, type BvaSections } from '@/components/accounting/budgets/BudgetVsActualTable';

interface ReportYear { fiscalYear: number; startDate: string; endDate: string; kind: string }

interface BudgetReport {
  period: string;
  lines: BvaLine[];
  sections: BvaSections;
  /** Latest posted entry inside the window, or null when nothing is posted. */
  posted_through: string | null;
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
  const [fiscalPeriod, setFiscalPeriod] = useState('ytd');
  // The financial year picked for year to date / full year; null = the year holding today.
  const [chosenYear, setChosenYear] = useState<number | null>(null);
  const [years, setYears] = useState<ReportYear[]>([]);
  const [shownYear, setShownYear] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');

  const selectedYear = chosenYear ?? shownYear;
  const yearOptions: Array<{ fiscalYear: number; startDate: string; endDate: string }> = years.length > 0
    ? years : selectedYear !== null ? [{ fiscalYear: selectedYear, startDate: '', endDate: '' }] : [];
  // The range the report itself covers, so a drill-down foots to its line.
  const range = parseReportPeriod(report?.period);

  // This period has no year to choose; the other periods take the chosen one.
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
                      {fiscalPeriod === 'current' ? 'This period: ' : ''}{longDate(range.start)} to {longDate(range.end)}
                    </p>
                  )}
                  {range && report && (
                    <p data-testid="posted-through" className="text-xs text-[var(--ff-text-secondary)]">
                      {report.posted_through
                        ? `Actuals posted through ${longDate(report.posted_through)}`
                        : 'No actuals posted in this range yet'}
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
              <option value="current">This period</option>
              <option value="ytd">Year to date</option>
              <option value="full_year">Full year</option>
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
                    There is nothing to show for year to date yet; choose Full year to see its budget.
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
            <BudgetVsActualTable lines={report.lines} sections={report.sections} range={range} />
          )}
        </div>
      </div>
    </AppLayout>
  );
}
