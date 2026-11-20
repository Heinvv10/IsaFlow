/**
 * An EMP501 version finalised before the BRS code fix (wave 6 EZF) stored figures in the old layout:
 * - each certificate carried the employment start and leaving dates and whole months worked (written under 3200 / 3210 /
 *   3215), not the certificate tax period (3170 / 3180) and pay periods (3200 / 3210);
 * - the employer's physicalSuburb (2065) held the company's PROVINCE, which is never a suburb.
 * They are read in today's shape by deriving those exactly as easyFileInput derives them now, from the same stored
 * dates and the version's own period, so a version finalised before the fix still builds its file, shows in the
 * employee portal, and shows drift only where its figures changed. What cannot be derived (a leaver paid after leaving:
 * no payment date was stored) is refused by name.
 */
import { emp501Period, type Emp501Kind } from './emp501Period';
import { certificateTaxPeriod, monthlyPayPeriodsWorked } from './easyFileEmployeeFacts';
import { UsageError } from './easyFileFields';
import type { EmployerInput } from './easyFileTypes';

interface LegacyFields {
  employmentStartDate?: string; employmentEndDate?: string | null; periodsInYoA?: number;
  surname?: string; certificateNumber?: string;
}

/** True when the stored certificates are in the layout from before the fix. */
export function isLegacyLayout(employees: readonly object[]): boolean {
  return employees.some((e) => !('taxPeriodStart' in e) && 'employmentStartDate' in e);
}

/** Today's shape for a stored certificate; a certificate already in it comes back as it is. */
export function currentCertificate<T extends object>(stored: T, taxYear: number, kind: Emp501Kind): T {
  if ('taxPeriodStart' in stored) return stored;
  const { employmentStartDate, employmentEndDate, periodsInYoA: _months, ...rest } = stored as T & LegacyFields;
  if (!employmentStartDate) return stored;
  const p = emp501Period(taxYear, kind);
  const period = certificateTaxPeriod({
    first: p.start.replaceAll('-', ''), last: p.end.replaceAll('-', ''), employmentStart: employmentStartDate, employmentEnd: employmentEndDate ?? null,
  });
  if (!period) {
    const who = `${(stored as LegacyFields).surname ?? ''} (certificate ${(stored as LegacyFields).certificateNumber ?? ''})`;
    throw new UsageError(`${who}: this version was finalised before the e@syFile code fix, and the employee's employment `
      + 'is outside the period, so its certificate tax period (codes 3170 / 3180) cannot be rebuilt from what was stored. '
      + 'Amend the return and finalise it again.');
  }
  return {
    ...rest, taxPeriodStart: period.start, taxPeriodEnd: period.end, payPeriodsInYear: 12,
    payPeriodsWorked: monthlyPayPeriodsWorked(period.start, period.end),
  } as T;
}

/** Today's employer record of a version in the old layout: 2065 carried the province, so it is dropped (easyFileInput). */
export function currentEmployer<T extends Pick<EmployerInput, 'physicalSuburb'>>(stored: T, legacy: boolean): T {
  return legacy && stored.physicalSuburb !== null ? { ...stored, physicalSuburb: null } : stored;
}

/**
 * For DISPLAY only (the employee portal, wave 6 EZF review): today's shape without applying any file rule, never
 * throwing. A certificate currentCertificate cannot rebuild (a leaver paid after leaving: no payment date stored) shows
 * its stored employment dates clamped to the period, the end never before the start.
 */
export function displayCertificate<T extends object>(stored: T, taxYear: number, kind: Emp501Kind): T {
  try {
    return currentCertificate(stored, taxYear, kind);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    const { employmentStartDate, employmentEndDate, periodsInYoA: _months, ...rest } = stored as T & LegacyFields;
    const p = emp501Period(taxYear, kind);
    const [first, last] = [p.start.replaceAll('-', ''), p.end.replaceAll('-', '')];
    const clamp = (d: string) => (d < first ? first : d > last ? last : d);
    const start = clamp(employmentStartDate ?? first);
    const end = clamp(employmentEndDate ?? last);
    const taxPeriodEnd = end < start ? start : end;
    return { ...rest, taxPeriodStart: start, taxPeriodEnd, payPeriodsInYear: 12, payPeriodsWorked: monthlyPayPeriodsWorked(start, taxPeriodEnd) } as T;
  }
}
