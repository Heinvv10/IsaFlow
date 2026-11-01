/**
 * Budget vs Actual (budgets P3, spec `docs/plans/budgets/P3-tracking-spec.md` §1)
 * Sage equivalent: Reports > Budget vs Actual
 *
 * The tracking engine's report (`/api/accounting/reports-budget-tracking`) in the
 * income-statement bands through `StatementGrid`: Actual · Budget · Var R ·
 * Var %, then Projected FY · FY budget · Δ FY budget. "—" is an absent budget,
 * never 0. Period Month | Quarter | YTD | FY | Custom (whole months), the
 * version of FY* (primary by default), and the CC1 / CC2 / BU filter. A line
 * expands into its GL transactions for the same window and filter, each linked
 * to its source document. CSV and Excel come from the same engine and rows.
 * The page renders; it computes no figure.
 */
import type { BudgetTrackingReport } from '@/modules/accounting/services/budgets/tracking/trackingTypes';
import { useMemo, useState } from 'react';
import { AppLayout } from '@/components/layout/AppLayout';
import { AlertCircle, BarChart3, Download, FileSpreadsheet } from 'lucide-react';
import { ListSkeleton } from '@/components/ui/ListSkeleton';
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';
import { longDate } from '@/components/accounting/budgets/budgetClient';
import { BudgetTrackingControls } from '@/components/accounting/budgets/tracking/BudgetTrackingControls';
import { BudgetTrackingHeader, BudgetTrackingNotices, projectionHeading } from '@/components/accounting/budgets/tracking/BudgetTrackingNotices';
import { BudgetTrackingVisuals } from '@/components/accounting/budgets/tracking/BudgetTrackingVisuals';
import { hasDimensionFilter } from '@/components/accounting/budgets/tracking/trackingControls';
import { useBudgetTracking } from '@/components/accounting/budgets/tracking/useBudgetTracking';
import type { StatementColumns } from '@/modules/accounting/services/reports/statementRows/statementModel';
import { toBudgetTrackingRows } from '@/modules/accounting/services/reports/statementRows/budgetTrackingRows';

const COLUMNS: StatementColumns = { prior: false, budget: true, variance: true, trend: false, projection: true };
const BUTTON = 'px-4 py-2 rounded-lg flex items-center gap-2 text-sm font-medium disabled:opacity-50';

/** Every year the window reaches: those with a version (`versionsByFy`) and those without one (`noVersionYears`), in order. */
const windowYears = (report: BudgetTrackingReport): number[] =>
  [...new Set([...Object.keys(report.versionsByFy ?? {}).map(Number), ...report.notices.noVersionYears])].sort((a, b) => a - b);

export default function BudgetVsActualPage() {
  const t = useBudgetTracking();
  const { report, controls } = t;
  const [expanded, setExpanded] = useState<string | null>(null);
  const rows = useMemo(() => (report ? toBudgetTrackingRows(report) : []), [report]);
  const filtered = hasDimensionFilter(controls);
  const hasLines = !!report && report.lines.length > 0;

  const openExport = (format: 'csv' | 'xlsx') => {
    window.open(`/api/accounting/budget-tracking-export?format=${format}&${t.exportQuery}`, '_blank');
  };

  return (
    <AppLayout>
      <div className="min-h-screen bg-[var(--ff-bg-primary)]">
        <div className="border-b border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
          <div className="px-4 sm:px-6 py-4 flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-3">
              <div className="p-2 rounded-lg bg-violet-500/10">
                <BarChart3 className="h-6 w-6 text-violet-500" />
              </div>
              <div>
                <h1 className="text-2xl font-bold text-[var(--ff-text-primary)]">Budget vs Actual</h1>
                <p className="text-sm text-[var(--ff-text-secondary)]">
                  Actuals against the budget in the income-statement bands, with the projected full year
                </p>
                {report && <BudgetTrackingHeader report={report} />}
              </div>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => openExport('csv')} disabled={!hasLines}
                className={`${BUTTON} bg-brand-600 hover:bg-brand-700 text-white`}>
                <Download className="h-4 w-4" /> Export CSV
              </button>
              <button type="button" onClick={() => openExport('xlsx')} disabled={!hasLines}
                className={`${BUTTON} border border-[var(--ff-border-light)] text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)]`}>
                <FileSpreadsheet className="h-4 w-4" /> Export Excel
              </button>
            </div>
          </div>
        </div>

        <div className="p-4 sm:p-6 space-y-4">
          <BudgetTrackingControls controls={controls} years={t.years} shownYear={report?.window.fiscalYear ?? null}
            today={t.today} versions={t.versions} versionsError={t.versionsError}
            crossYears={report?.versionsByFy ? windowYears(report) : null}
            centres={t.centres} units={t.units} update={t.update} setPeriod={t.setPeriod} setFiscalYear={t.setFiscalYear}
            problem={t.problem} />
          {Object.keys(t.refError).length > 0 && (
            <p role="alert" className="text-xs text-amber-600 dark:text-amber-400">{Object.values(t.refError).join(' ')}</p>
          )}

          {t.problem ? (
            <p className="py-8 text-center text-sm text-[var(--ff-text-secondary)]">Correct the period above to load the report.</p>
          ) : t.isLoading ? (
            <ListSkeleton rows={14} label="Loading budget vs actual" />
          ) : t.error ? (
            <div className="flex flex-wrap items-center gap-3 text-red-500 py-8 justify-center">
              <AlertCircle className="h-5 w-5" />
              <span>{t.error}</span>
              <button type="button" onClick={t.retry}
                className="px-3 py-1.5 rounded-lg border border-[var(--ff-border-light)] text-sm font-medium text-[var(--ff-text-primary)] hover:bg-[var(--ff-bg-hover)]">
                Retry
              </button>
            </div>
          ) : report?.window.notStarted ? (
            <div className="text-center py-12">
              <p data-testid="year-not-started" className="text-[var(--ff-text-secondary)]">
                {`This financial year starts on ${longDate(report.window.startDate)}`}
              </p>
              <p className="text-sm text-[var(--ff-text-secondary)] mt-1">
                There is nothing to show for year to date yet; choose Full year to see its budget.
              </p>
            </div>
          ) : !report || !hasLines ? (
            <div className="space-y-4">
              {/* The reason a window is empty is in the notices: a year with a budget, none of it at this filter, says so here too. */}
              {report && <BudgetTrackingNotices report={report} filtered={filtered} onViewUnfiltered={t.clearFilter} />}
            <div className="text-center py-12">
              <BarChart3 className="h-12 w-12 text-[var(--ff-text-tertiary)] mx-auto mb-3" />
              <p className="text-[var(--ff-text-secondary)]">No budget or actuals in this window</p>
              <p className="text-sm text-[var(--ff-text-secondary)] mt-1">
                Set a budget per GL account, or choose another period, version or filter.
              </p>
            </div>
            </div>
          ) : (
            <>
              <BudgetTrackingNotices report={report} filtered={filtered} onViewUnfiltered={t.clearFilter} />
              <p className="sm:hidden text-xs text-[var(--ff-text-secondary)]">
                Swipe the statement sideways for the variance and projected-year columns.
              </p>
              <div id="bva-statement" tabIndex={-1}>
              <StatementGrid rows={rows} columns={COLUMNS} title={report.window.label} sticky cents budgetTracking
                projectionTitle={projectionHeading(report.projection)}
                expandedAccount={expanded}
                onToggleAccount={(code) => setExpanded((e) => (e === code ? null : code))}
                renderDrill={(code) => (
                  <AccountDrillDown accountCode={code} periodStart={report.window.startDate} periodEnd={report.window.endDate}
                    cc1Id={report.filter.cc1?.id} cc2Id={report.filter.cc2?.id}
                    businessUnitId={report.filter.bu?.id} budgetTracking asTableRow={false} />
                )} />
              </div>
              <BudgetTrackingVisuals report={report} filtered={filtered} groupBy={controls.groupBy}
                onGroupBy={(groupBy) => t.update({ groupBy })} />
            </>
          )}
        </div>
      </div>
    </AppLayout>
  );
}
