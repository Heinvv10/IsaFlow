/**
 * A pay line's ETI (wave 5 ET): the remuneration, the hours and the minimum-wage inputs, the engine call, and the
 * warnings. Split from payrollCalculator so the calculator stays the PAYE/UIF/SDL story; the rules are in etiHours.ts
 * (sources there) and etiEngine.ts.
 */
import { formatMoney } from '@/lib/money/formatMoney';
import { resolveEtiForEmployee } from './etiEngine';
import { etiHoursOf, etiRemunerationOf, ordinaryWageCents } from './etiHours';
import { etiIdDocumentShown, idDateOfBirthMismatch } from './etiEligibility';
import { nationalMinimumWageCents } from './etiTables';
import { unitOf } from './payrollRunHours';
import type { EmployeeComponent, EtiResult, PayrollEmployee, PayrollPeriod, ValidationResult } from './payrollTypes';

export interface LineEtiInput {
  employee: PayrollEmployee;
  components: EmployeeComponent[];
  period: PayrollPeriod;
  periodDate: Date;
  /** HD's run hours (null when not told). */
  runHours: number | null;
  /** Paid after leaving: no hours in the period, so nil (s7(5)). */
  notEmployedInPeriod: boolean;
  /** False for an independent contractor (TS-b): not an employee, so no ETI. */
  etiApplies: boolean;
}

const nil = (r: EtiResult, ineligibilityReason: string): EtiResult => ({
  ...r, isEligible: false, isDeterminable: true, missingInputs: [], monthlyEti: 0, ineligibilityReason,
});

export function costLineEti(input: LineEtiInput): { eti: EtiResult; warnings: ValidationResult[] } {
  const { employee, components, period, periodDate } = input;
  const warnings: ValidationResult[] = [];
  const name = `${employee.firstName} ${employee.lastName}`.trim();
  const h = input.notEmployedInPeriod ? null : etiHoursOf(employee, period, input.runHours, components);
  const wageCents = ordinaryWageCents(components);
  // Missing dates are reported as indeterminate, never fabricated into "not eligible" (resolveEtiForEmployee).
  const resolved = resolveEtiForEmployee({
    dateOfBirth: employee.dateOfBirth,
    employmentStartDate: employee.startDate,
    periodDate,
    monthlyRemuneration: etiRemunerationOf(components),
    isUifExcluded: employee.uifExcluded,
    hours: h?.hours == null ? null : { monthlyHours: h.hours, ordinaryHours: h.ordinaryHours, ordinaryWageCents: wageCents },
    idDocumentShown: etiIdDocumentShown(employee) && !idDateOfBirthMismatch(employee),
    priorMonths: employee.etiPriorMonths ?? 0,
  });
  if (input.notEmployedInPeriod) {
    return { eti: nil(resolved, 'Not employed in this period (paid after leaving): ETI is apportioned by hours employed, none here.'), warnings };
  }
  if (!input.etiApplies) return { eti: nil(resolved, 'Independent contractor: not an employee, so no ETI.'), warnings };

  // Hours that cannot be told are never a full month. A monthly employee keeps the unapportioned figure; an hourly or
  // daily one, whose pay is the hours, claims none (HD's nil). R-B assumed hours apportion, and still warn.
  const byTime = unitOf(employee) != null;
  let eti = resolved;
  if (h?.hours == null && resolved.monthlyEti > 0) {
    if (byTime) eti = nil(resolved, 'The hours or days worked cannot be told, so ETI cannot be apportioned by hours: none is claimed.');
    warnings.push({
      code: 'ETI_HOURS_UNKNOWN', severity: 'warning',
      message: byTime
        ? `${name}'s hours or days worked this month cannot be told, so no ETI was claimed (ETI Act s7(5) apportions it by hours). Enter them and recalculate.`
        : `No ordinary hours a week are recorded for ${name}, so ETI of ${formatMoney(resolved.monthlyEti)} was claimed as for a full month, without `
          + 'apportioning it by hours (ETI Act s7(5)) or testing the wage against the national minimum wage (s4(1)(a)). Record the hours a week on the employee and recalculate.',
    });
  } else if (h?.assumed && resolved.isEligible) {
    warnings.push({
      code: 'ETI_HOURS_UNKNOWN', severity: 'warning',
      message: `No ordinary hours a week are recorded for ${name}, who was employed for part of the month: ETI of ${formatMoney(resolved.monthlyEti)} was `
        + `apportioned on an assumed 40 hours a week (${h.hours} hours), and the wage was not tested against the national minimum wage. Record the hours a week and recalculate.`,
    });
  }
  if (h?.ordinaryHours != null && resolved.monthlyEti > 0 && nationalMinimumWageCents(periodDate) == null) {
    warnings.push({
      code: 'ETI_MINIMUM_WAGE_UNKNOWN', severity: 'warning',
      message: `No national minimum wage is loaded for this period, so ${name}'s wage was not tested against it (ETI Act s4(1)(a)). Check it before claiming the ETI.`,
    });
  }
  // A nil for the minimum wage is never silent: say what was tested, and the cases the engine cannot see.
  if (h?.ordinaryHours != null && /national minimum wage/.test(resolved.ineligibilityReason ?? '')) {
    warnings.push({
      code: 'ETI_MINIMUM_WAGE_FAILED', severity: 'warning',
      message: wageCents === 0
        ? `${name} has no basic pay on SARS code 3601, so the wage for ordinary hours is nil and no ETI was claimed. If basic pay is on another code, move it to 3601 and recalculate.`
        : `${name}'s basic pay (${formatMoney(wageCents / 100)}) is below the national minimum wage for ${h.ordinaryHours} ordinary hours, so no ETI was claimed (ETI Act s4(1)(a)). `
          + 'If the month is short because of unpaid leave, the hours paid were fewer: check the claim by hand.',
    });
  }
  // Round 3 (adv3 L1): the ID number and the date of birth disagree, so the age ETI turns on cannot be trusted.
  if (idDateOfBirthMismatch(employee) && resolved.missingInputs.includes('id_document')) {
    warnings.push({
      code: 'ETI_ID_DOB_MISMATCH', severity: 'warning',
      message: `${name}'s ID number gives a date of birth of ${(employee.idNumber ?? '').replace(/\s+/g, '').slice(0, 6)} (YYMMDD), but the date of birth recorded is different, `
        + 'so no ETI was claimed (ETI turns on the age, ETI Act s6(a)). Correct whichever is wrong on the employee and recalculate.',
    });
  }
  // ETI Act s6(c) and s6(d): a connected person (Income Tax Act s1) and a domestic worker (BCEA s1) do not qualify. Neither
  // is captured yet, so every claim says so at approval (Hein ruling, review round 2): a warning, not a block.
  if (eti.monthlyEti > 0) {
    warnings.push({
      code: 'ETI_CONNECTED_OR_DOMESTIC_UNCHECKED', severity: 'warning',
      message: `ETI of ${formatMoney(eti.monthlyEti)} is claimed for ${name}. Confirm ${name} is not a connected person in relation to the employer `
        + '(Income Tax Act s1) and not a domestic worker (BCEA s1): neither qualifies (ETI Act s6(c), s6(d)), and IsaFlow does not record either yet.',
    });
  }
  return { eti, warnings };
}
