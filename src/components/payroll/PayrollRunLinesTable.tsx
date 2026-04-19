/**
 * PayrollRunLinesTable — lines table for a payroll run detail page.
 * Includes a per-row payslip download link (hidden when status is draft).
 */
import { CheckCircle2 } from 'lucide-react';
import { formatCurrency } from '@/utils/formatters';

export interface Line {
  id: string;
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  grossPay: number;
  taxableIncome: number;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  eti: number;
  netPay: number;
}

export interface PayrollRunLinesTableProps {
  runId: string;
  lines: Line[];
  runStatus: string;
}

export function PayrollRunLinesTable({ runId, lines, runStatus }: PayrollRunLinesTableProps) {
  return (
    <section className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] overflow-hidden">
      <div className="px-4 py-3 border-b border-[var(--ff-border-primary)] flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Line items</h2>
        {runStatus === 'calculated' && (
          <span className="flex items-center gap-1 text-xs text-teal-400">
            <CheckCircle2 className="h-4 w-4" /> Calculated
          </span>
        )}
      </div>

      {lines.length === 0 ? (
        <div className="p-8 text-center text-[var(--ff-text-tertiary)] text-sm">
          No lines yet — press <span className="text-teal-400 font-medium">Calculate</span> to generate payroll for this period.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--ff-bg-secondary)] text-left">
              <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium">Emp #</th>
              <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium">Name</th>
              <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Gross</th>
              <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">PAYE</th>
              <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">UIF (E)</th>
              <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">UIF (R)</th>
              <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">SDL</th>
              <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">ETI</th>
              <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Net</th>
              <th className="py-2 px-4 text-[var(--ff-text-secondary)] font-medium text-right">Payslip</th>
            </tr>
          </thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.id} className="border-t border-[var(--ff-border-primary)]">
                <td className="py-2 px-4 font-mono text-xs text-[var(--ff-text-secondary)]">{l.employeeNumber}</td>
                <td className="py-2 px-4 text-[var(--ff-text-primary)]">{l.employeeName}</td>
                <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-primary)]">{formatCurrency(l.grossPay)}</td>
                <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(l.paye)}</td>
                <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(l.uifEmployee)}</td>
                <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(l.uifEmployer)}</td>
                <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(l.sdl)}</td>
                <td className="py-2 px-4 text-right font-mono text-[var(--ff-text-secondary)]">{formatCurrency(l.eti)}</td>
                <td className="py-2 px-4 text-right font-mono text-teal-400 font-medium">{formatCurrency(l.netPay)}</td>
                <td className="py-2 px-4 text-right">
                  {runStatus !== 'draft' && (
                    <a
                      href={`/api/payroll/runs/${runId}/payslip/${l.employeeId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-teal-400 hover:text-teal-300 text-xs font-medium"
                    >
                      Payslip
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
