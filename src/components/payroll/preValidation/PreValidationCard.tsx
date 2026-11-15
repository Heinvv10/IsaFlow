/**
 * IRP5 / EMP501 pre-validation card on the payroll compliance hub (wave 6 PV): the IRP5 validation engine over the
 * tax year to date for every employee with a final pay run, each issue with its severity and a link to the field
 * that fixes it. Read-only: it never blocks a run or a filing.
 */
import { useState } from 'react';
import Link from 'next/link';
import { AlertCircle, AlertTriangle, CheckCircle2, Loader2, ShieldCheck } from 'lucide-react';
import { currentPayeTaxYear } from '@/modules/accounting/utils/payeTaxYearToday';
import { noReleaseNotice, SEVERITY_LABEL, SEVERITY_TEXT, usePreValidation } from './usePreValidation';

function yearLabel(taxYear: number): string {
  return `${taxYear} (Mar ${taxYear - 1} - Feb ${taxYear})`;
}

export function PreValidationCard() {
  const current = currentPayeTaxYear();
  const [taxYear, setTaxYear] = useState(current);
  const { data, error, loading } = usePreValidation(`taxYear=${taxYear}`);

  return (
    <section aria-labelledby="pre-validation-title" className="p-5 rounded-xl border border-[var(--ff-border-primary)] bg-[var(--ff-bg-secondary)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <ShieldCheck className="w-5 h-5 text-teal-600 dark:text-teal-400" aria-hidden="true" />
          <h2 id="pre-validation-title" className="text-base font-semibold text-[var(--ff-text-primary)]">IRP5 / EMP501 pre-validation</h2>
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]">
          Tax year
          <select value={taxYear} onChange={(e) => setTaxYear(Number(e.target.value))}
            className="px-2 py-1 rounded-lg bg-[var(--ff-bg-tertiary)] border border-[var(--ff-border-primary)] text-[var(--ff-text-primary)] text-sm">
            {[current, current - 1].map((y) => <option key={y} value={y}>{yearLabel(y)}</option>)}
          </select>
        </label>
      </div>
      <p className="mt-1 text-sm text-[var(--ff-text-secondary)]">
        The IRP5 checks for every employee on a final pay run this tax year, so faults are fixed before the EMP501. Nothing here blocks a run.
      </p>

      {loading && <p className="mt-4 flex items-center gap-2 text-sm text-[var(--ff-text-secondary)]"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> Checking…</p>}
      {error && <p role="alert" className="mt-4 text-sm text-red-700 dark:text-red-400">{error}</p>}
      {data && (
        <div className="mt-4 space-y-3">
          <p className="text-sm text-[var(--ff-text-primary)]" data-testid="pre-validation-summary">
            {data.employeesChecked} employee{data.employeesChecked === 1 ? '' : 's'} checked · {data.errors} error{data.errors === 1 ? '' : 's'} · {data.warnings} warning{data.warnings === 1 ? '' : 's'}
          </p>
          {!data.codeReleaseLoaded && data.employeesChecked > 0 && (
            <p className="flex gap-2 text-sm text-amber-700 dark:text-amber-400"><AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />{noReleaseNotice(data.taxYear)}</p>
          )}
          {data.employees.length === 0 ? (
            <p className="flex gap-2 text-sm text-[var(--ff-text-secondary)]">
              <CheckCircle2 className="w-4 h-4 shrink-0 text-teal-600 dark:text-teal-400" aria-hidden="true" />
              {data.employeesChecked === 0 ? 'No final pay run in this tax year yet.' : 'No issues found.'}
            </p>
          ) : (
            <ul className="divide-y divide-[var(--ff-border-primary)]">
              {data.employees.map((emp) => (
                <li key={emp.employeeId} className="py-3">
                  <Link href={`/payroll/employees/${emp.employeeId}`} className="text-sm font-medium text-[var(--ff-text-primary)] hover:underline">
                    {emp.name} <span className="font-id text-[var(--ff-text-secondary)]">{emp.employeeNumber}</span>
                  </Link>
                  <ul className="mt-1 space-y-1">
                    {emp.issues.map((issue, i) => (
                      <li key={`${issue.code}-${i}`} className={`flex flex-wrap items-start gap-2 text-sm ${SEVERITY_TEXT[issue.severity]}`}>
                        {issue.severity === 'error' ? <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" /> : <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />}
                        <span className="flex-1 min-w-0"><span className="font-medium">{SEVERITY_LABEL[issue.severity]}:</span> {issue.message}</span>
                        <Link href={issue.fixHref} className="underline text-teal-700 dark:text-teal-400">Fix: {issue.fixLabel}</Link>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
