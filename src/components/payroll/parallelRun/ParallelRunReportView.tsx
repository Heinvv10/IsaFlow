/**
 * Parallel-run comparison report: summary chips, per-component grand totals,
 * and a per-employee table with expandable component drill-down.
 * All amounts arrive as integer cents.
 */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type {
  EmployeeComparison,
  ParallelRunComparisonReport,
} from '@/modules/accounting/services/payroll/payrollParallelRunTypes';
import { COMPONENT_LABELS } from '@/modules/accounting/services/payroll/payrollParallelRunTypes';

function rand(cents: number | null): string {
  if (cents === null) return '—';
  return (cents / 100).toLocaleString('en-ZA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const STATUS_STYLES: Record<EmployeeComparison['status'], string> = {
  match: 'bg-teal-500/10 text-teal-400',
  variance: 'bg-red-500/10 text-red-400',
  missing_in_isaflow: 'bg-amber-500/10 text-amber-400',
  missing_in_external: 'bg-amber-500/10 text-amber-400',
};
const STATUS_LABELS: Record<EmployeeComparison['status'], string> = {
  match: 'Match',
  variance: 'Variance',
  missing_in_isaflow: 'Missing in IsaFlow',
  missing_in_external: 'Missing in external',
};

function diffClass(diffCents: number | null): string {
  if (diffCents === null) return 'text-[var(--ff-text-tertiary)]';
  return diffCents === 0 ? 'text-teal-400' : 'text-red-400';
}

function SummaryChip({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  const toneClass = tone === 'good' ? 'text-teal-400' : tone === 'bad' ? 'text-red-400' : 'text-[var(--ff-text-primary)]';
  return (
    <div className="rounded-xl border border-[var(--ff-border)] bg-[var(--ff-bg-secondary)] px-4 py-3">
      <div className={`text-xl font-semibold ${toneClass}`}>{value}</div>
      <div className="text-xs text-[var(--ff-text-tertiary)]">{label}</div>
    </div>
  );
}

export function ParallelRunReportView({ report }: { report: ParallelRunComparisonReport }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const s = report.summary;
  const clean = s.withVariance === 0 && s.missingInIsaflow === 0 && s.missingInExternal === 0;

  const toggle = (num: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num); else next.add(num);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <SummaryChip label="IsaFlow employees" value={String(s.employeesIsaflow)} />
        <SummaryChip label="External payslips" value={String(s.employeesExternal)} />
        <SummaryChip label="Match to the cent" value={String(s.matchToTheCent)} tone="good" />
        <SummaryChip label="With variance" value={String(s.withVariance)} tone={s.withVariance > 0 ? 'bad' : 'good'} />
        <SummaryChip
          label="Missing either side"
          value={String(s.missingInIsaflow + s.missingInExternal)}
          tone={s.missingInIsaflow + s.missingInExternal > 0 ? 'bad' : 'good'}
        />
        <SummaryChip
          label="Match rate"
          value={s.matchRate === null ? '—' : `${(s.matchRate * 100).toFixed(1)}%`}
          tone={clean && s.matchRate === 1 ? 'good' : 'bad'}
        />
      </div>

      <div className={`rounded-xl border px-4 py-3 text-sm font-medium ${
        clean ? 'border-teal-500/30 bg-teal-500/10 text-teal-400'
              : 'border-red-500/30 bg-red-500/10 text-red-400'
      }`}>
        {clean
          ? 'Parallel run reconciles to the cent — cutover gate passed for this period.'
          : 'Discrepancies found — resolve every variance and missing employee before cutover.'}
      </div>

      <div className="rounded-xl border border-[var(--ff-border)] bg-[var(--ff-bg-secondary)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-[var(--ff-text-tertiary)] border-b border-[var(--ff-border)]">
              <th className="px-4 py-2">Component totals</th>
              <th className="px-4 py-2 text-right">IsaFlow</th>
              <th className="px-4 py-2 text-right">External</th>
              <th className="px-4 py-2 text-right">Diff</th>
            </tr>
          </thead>
          <tbody>
            {s.componentTotals.map((c) => (
              <tr key={c.component} className="border-b border-[var(--ff-border)] last:border-0">
                <td className="px-4 py-2 text-[var(--ff-text-secondary)]">{COMPONENT_LABELS[c.component]}</td>
                <td className="px-4 py-2 text-right tabular-nums">{rand(c.isaflowCents)}</td>
                <td className="px-4 py-2 text-right tabular-nums">{rand(c.externalCents)}</td>
                <td className={`px-4 py-2 text-right tabular-nums ${diffClass(c.diffCents)}`}>{rand(c.diffCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="rounded-xl border border-[var(--ff-border)] bg-[var(--ff-bg-secondary)] overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-[var(--ff-text-tertiary)] border-b border-[var(--ff-border)]">
              <th className="px-4 py-2 w-8" />
              <th className="px-4 py-2">Employee</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2 text-right">Largest diff</th>
            </tr>
          </thead>
          <tbody>
            {report.employees.map((emp) => {
              const isOpen = expanded.has(emp.employeeNumber);
              return [
                <tr
                  key={emp.employeeNumber}
                  onClick={() => toggle(emp.employeeNumber)}
                  className="border-b border-[var(--ff-border)] cursor-pointer hover:bg-[var(--ff-bg-tertiary)]"
                >
                  <td className="px-4 py-2 text-[var(--ff-text-tertiary)]">
                    {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                  </td>
                  <td className="px-4 py-2">
                    <span className="font-medium text-[var(--ff-text-primary)]">{emp.employeeNumber}</span>
                    <span className="ml-2 text-[var(--ff-text-tertiary)]">{emp.employeeName}</span>
                  </td>
                  <td className="px-4 py-2">
                    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[emp.status]}`}>
                      {STATUS_LABELS[emp.status]}
                    </span>
                  </td>
                  <td className={`px-4 py-2 text-right tabular-nums ${emp.maxAbsDiffCents > 0 ? 'text-red-400' : 'text-teal-400'}`}>
                    {rand(emp.maxAbsDiffCents)}
                  </td>
                </tr>,
                isOpen ? (
                  <tr key={`${emp.employeeNumber}-detail`} className="border-b border-[var(--ff-border)] bg-[var(--ff-bg-primary)]">
                    <td />
                    <td colSpan={3} className="px-4 py-2">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-[var(--ff-text-tertiary)]">
                            <th className="py-1 pr-4">Component</th>
                            <th className="py-1 pr-4 text-right">IsaFlow</th>
                            <th className="py-1 pr-4 text-right">External</th>
                            <th className="py-1 text-right">Diff</th>
                          </tr>
                        </thead>
                        <tbody>
                          {emp.components.map((c) => (
                            <tr key={c.component}>
                              <td className="py-1 pr-4 text-[var(--ff-text-secondary)]">{COMPONENT_LABELS[c.component]}</td>
                              <td className="py-1 pr-4 text-right tabular-nums">{rand(c.isaflowCents)}</td>
                              <td className="py-1 pr-4 text-right tabular-nums">{rand(c.externalCents)}</td>
                              <td className={`py-1 text-right tabular-nums ${diffClass(c.diffCents)}`}>{rand(c.diffCents)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                ) : null,
              ];
            })}
            {report.employees.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-6 text-center text-[var(--ff-text-tertiary)]">
                  Nothing to compare — both sides are empty.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
