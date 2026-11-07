/**
 * EmployeePayslipsCard — the employee's payslips on their profile (wave 4 PS): one row
 * per run (period, Final or Draft by the R-035 guard, stored net), each opening the
 * slip in PayslipDrawer. Payroll-detail roles only (the route refuses the rest).
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, FileText, Loader2 } from 'lucide-react';
import { apiErrorMessage, apiJson } from '@/lib/apiFetch';
import { formatCurrency } from '@/utils/formatters';
import { PayslipDrawer, type PayslipTarget } from './PayslipDrawer';
import type { EmployeePayslipEntry } from '@/modules/accounting/services/payroll/payslipHistory';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FAILED = 'Could not load the payslips - try again';

export function EmployeePayslipsCard({ employeeId, employeeName }: { employeeId: string; employeeName: string }) {
  const [entries, setEntries] = useState<EmployeePayslipEntry[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<PayslipTarget | null>(null);

  const load = useCallback(async () => {
    setError('');
    try {
      setEntries(await apiJson(`/api/payroll/employees/${employeeId}/payslips`, undefined, FAILED));
    } catch (err) {
      setEntries([]);
      setError(apiErrorMessage(err, FAILED));
    }
  }, [employeeId]);
  useEffect(() => { void load(); }, [load]);

  return (
    <section aria-labelledby="employee-payslips-heading"
      className="rounded-lg border border-[var(--ff-border-primary)] bg-[var(--ff-surface-primary)] p-5">
      <div className="mb-4 flex items-center gap-2">
        <FileText className="h-5 w-5 text-teal-600 dark:text-teal-400" aria-hidden="true" />
        <h3 id="employee-payslips-heading" className="text-base font-semibold text-[var(--ff-text-primary)]">Payslips</h3>
      </div>
      {entries === null ? (
        <p className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading payslips…
        </p>
      ) : error ? (
        <p role="alert" className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />{error}
        </p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-[var(--ff-text-secondary)]">No payslips yet. A payslip appears once a pay run includes this employee.</p>
      ) : (
        <ul className="divide-y divide-[var(--ff-border-primary)] text-sm">
          {entries.map((e) => {
            const period = `${MONTHS[e.periodMonth - 1]} ${e.periodYear}`;
            return (
              <li key={e.runId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="text-[var(--ff-text-primary)]">{period}</span>
                <span className={e.final ? 'text-xs text-[var(--ff-text-secondary)]' : 'text-xs font-medium text-amber-700 dark:text-amber-400'}>
                  {e.final ? 'Final' : 'Draft'}
                </span>
                <span className="tabular-nums text-[var(--ff-text-primary)]">{formatCurrency(e.netPay)} net</span>
                <button type="button" onClick={() => setOpen({ runId: e.runId, employeeId, title: `${employeeName}, ${period}` })}
                  aria-label={`View payslip for ${period}`}
                  className="text-teal-700 underline hover:no-underline dark:text-teal-300">
                  View
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <PayslipDrawer target={open} onClose={() => setOpen(null)} />
    </section>
  );
}
