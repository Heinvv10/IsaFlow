/**
 * A certificate stored before the BRS code fix (wave 6 EZF) in an EMP501 version's figures: it carried the employment
 * start and leaving dates and whole months worked (written under 3200 / 3210 / 3215), not the certificate tax period
 * (3170 / 3180) and pay periods (3200 / 3210). It is read in today's shape by deriving those exactly as
 * easyFileInput derives them now, from the same stored dates and the version's own period, so a version finalised
 * before the fix still downloads, shows in the employee portal, and shows drift only where its figures changed.
 */
import { emp501Period, type Emp501Kind } from './emp501Period';
import { monthlyPayPeriodsWorked } from './easyFileEmployeeFacts';

interface LegacyFields { employmentStartDate?: string; employmentEndDate?: string | null; periodsInYoA?: number }

/** Today's shape for a stored certificate; a certificate already in it comes back as it is. */
export function currentCertificate<T extends object>(stored: T, taxYear: number, kind: Emp501Kind): T {
  if ('taxPeriodStart' in stored) return stored;
  const { employmentStartDate, employmentEndDate, periodsInYoA: _months, ...rest } = stored as T & LegacyFields;
  if (!employmentStartDate) return stored;
  const p = emp501Period(taxYear, kind);
  const first = p.start.replaceAll('-', '');
  const last = p.end.replaceAll('-', '');
  const taxPeriodStart = employmentStartDate > first ? employmentStartDate : first;
  const taxPeriodEnd = employmentEndDate && employmentEndDate < last ? employmentEndDate : last;
  return {
    ...rest, taxPeriodStart, taxPeriodEnd, payPeriodsInYear: 12, payPeriodsWorked: monthlyPayPeriodsWorked(taxPeriodStart, taxPeriodEnd),
  } as T;
}
