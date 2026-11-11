/** The collapsible payroll-runs table under the EMP201 form (moved from pages/accounting/sars/emp201.tsx). */
import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatDate } from '@/utils/formatters';
import { fmt, type EMP201PayrollRun } from './emp201Types';

export function Emp201RunsBreakdown({ runs }: { runs: EMP201PayrollRun[] }) {
  const [showRuns, setShowRuns] = useState(false);
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)]">
      <button
        onClick={() => setShowRuns(!showRuns)}
        className="w-full px-4 py-3 flex items-center justify-between hover:bg-[var(--ff-bg-primary)]/30"
      >
        <span className="text-sm font-medium text-[var(--ff-text-primary)]">
          Payroll Runs ({runs.length})
        </span>
        {showRuns ? (
          <ChevronDown className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
        ) : (
          <ChevronRight className="h-4 w-4 text-[var(--ff-text-tertiary)]" />
        )}
      </button>
      {showRuns && (
        <div className="border-t border-[var(--ff-border-light)]">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--ff-border-light)] text-left text-[var(--ff-text-secondary)]">
                <th className="px-4 py-2">Run Date</th>
                <th className="px-4 py-2 text-right">Employees</th>
                <th className="px-4 py-2 text-right">Gross Pay</th>
                <th className="px-4 py-2 text-right">PAYE</th>
                <th className="px-4 py-2 text-right">UIF</th>
                <th className="px-4 py-2 text-right">SDL</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-bg-primary)]/50">
                  <td className="px-4 py-2 text-[var(--ff-text-primary)]">{formatDate(run.runDate)}</td>
                  <td className="px-4 py-2 text-right text-[var(--ff-text-secondary)]">{run.employeeCount}</td>
                  <td className="px-4 py-2 text-right text-[var(--ff-text-primary)]">{fmt(run.grossPay)}</td>
                  <td className="px-4 py-2 text-right text-[var(--ff-text-secondary)]">{fmt(run.paye)}</td>
                  <td className="px-4 py-2 text-right text-[var(--ff-text-secondary)]">{fmt(run.uif)}</td>
                  <td className="px-4 py-2 text-right text-[var(--ff-text-secondary)]">{fmt(run.sdl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
