/**
 * One line on the employee profile (wave 6 PV): what the IRP5 checks say about this employee for the tax year to
 * date, each issue with its fix link. Silent until it has an answer. From March to May, while this tax year has no
 * final line yet, the previous year is still being filed (EMP501 annual, IRP5s): its line shows instead.
 */
import { todayInSast } from '@/lib/saDateParser';
import { currentPayeTaxYear } from '@/modules/accounting/utils/payeTaxYearToday';
import { usePreValidation, SEVERITY_TEXT, type PreValidation } from './usePreValidation';

/** March to May (SAST): the previous tax year's filing season. */
function inFilingSeason(): boolean {
  const month = Number(todayInSast().slice(5, 7));
  return month >= 3 && month <= 5;
}

function Line({ data }: { data: PreValidation }) {
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

export function PreValidationLine({ employeeId }: { employeeId: string }) {
  const id = encodeURIComponent(employeeId);
  const current = usePreValidation(`employeeId=${id}`);
  const fallback = current.data !== null && current.data.employeesChecked === 0 && inFilingSeason();
  const previous = usePreValidation(fallback ? `employeeId=${id}&taxYear=${currentPayeTaxYear() - 1}` : null);
  if (current.error) return <p className="mb-3 text-xs text-red-700 dark:text-red-400">{current.error}</p>;
  if (current.data && current.data.employeesChecked > 0) return <Line data={current.data} />;
  if (fallback && previous.data && previous.data.employeesChecked > 0) return <Line data={previous.data} />;
  return null;
}
