/**
 * Run approval (wave 6 PV): the IRP5 checks for the employees on this run, counting the run's own lines with the
 * year's final ones. Warnings only: approval is never blocked by them. Silent while loading and when all is clean.
 */
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { usePreValidation } from './usePreValidation';

export function PreValidationRunWarnings({ runId }: { runId: string }) {
  const { data, error } = usePreValidation(`runId=${encodeURIComponent(runId)}`);
  if (error) return <p className="text-amber-700 dark:text-amber-400">IRP5 checks could not be loaded: {error}</p>;
  if (!data || data.employees.length === 0) return null;
  const n = data.employees.length;
  return (
    <div className="text-amber-700 dark:text-amber-400" data-testid="pre-validation-run-warnings">
      <p className="flex gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>
          IRP5 checks: {n} employee{n === 1 ? '' : 's'} on this run {n === 1 ? 'has' : 'have'} {data.errors + data.warnings} issue{data.errors + data.warnings === 1 ? '' : 's'} to fix before the EMP501. They do not block approval.{' '}
          <Link href="/payroll/compliance" className="underline">See all</Link>
        </span>
      </p>
      <ul className="ml-6 mt-1 list-disc space-y-0.5">
        {data.employees.map((emp) => (
          <li key={emp.employeeId}>{emp.name}: {emp.issues.map((i) => i.message).join('; ')}</li>
        ))}
      </ul>
    </div>
  );
}
