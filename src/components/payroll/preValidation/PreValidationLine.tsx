/**
 * One line on the employee profile (wave 6 PV): what the IRP5 checks say about this employee for the tax year to
 * date, each issue with its fix link. Silent until it has an answer, and for an employee with no final pay run yet.
 */
import { usePreValidation, SEVERITY_TEXT } from './usePreValidation';

export function PreValidationLine({ employeeId }: { employeeId: string }) {
  const { data, error } = usePreValidation(`employeeId=${encodeURIComponent(employeeId)}`);
  if (error) return <p className="mb-3 text-xs text-red-700 dark:text-red-400">{error}</p>;
  if (!data || data.employeesChecked === 0) return null;
  const issues = data.employees[0]?.issues ?? [];
  return (
    <p className="mb-3 text-xs text-[var(--ff-text-secondary)]" data-testid="pre-validation-line">
      <span className="font-medium">IRP5 checks ({data.taxYear} tax year):</span>{' '}
      {issues.length === 0 ? 'no issues.' : issues.map((issue, i) => (
        <span key={`${issue.code}-${i}`} className={SEVERITY_TEXT[issue.severity]}>
          {i > 0 && '; '}{issue.message} (<a href={issue.fixHref} className="underline">{issue.fixLabel}</a>)
        </span>
      ))}
    </p>
  );
}
