import { ETI_TABLE_UNCONFIRMED_MESSAGE, isEtiTableUnconfirmed } from './etiTables';
import type { EmployeeComponent, EtiMissingInput, EtiResult, PayrollEmployee, ValidationResult } from './payrollTypes';
import type { EmploymentClassification } from './employmentTerms';

/** Error results that refuse approval of the run (payrollRunRecalcGate.employmentTermsRefusal). */
export const EMPLOYMENT_TERMS_BLOCKING_CODES = ['EMPLOYMENT_UNDETERMINED', 'DIRECTOR_STATUS_NOT_SET'] as const;

const MONTHLY_THRESHOLD = 95_750 / 12;

export function validateEmployee(
  employee: PayrollEmployee,
  existingTaxNumbers: string[],
  flags: { hasBankDetails?: boolean } = {},
): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (!employee.taxNumber) {
    results.push({
      code: 'MISSING_TAX_NUMBER',
      severity: 'error',
      message: `${employee.firstName} ${employee.lastName} has no SARS tax number. PAYE cannot be calculated.`,
      field: 'taxNumber',
      deepLink: `/payroll/employees/${employee.id}#tax-number`,
    });
  } else if (!/^\d{10}$/.test(employee.taxNumber)) {
    results.push({
      code: 'INVALID_TAX_NUMBER_FORMAT',
      severity: 'error',
      message: `Tax number ${employee.taxNumber} is invalid — must be 10 digits.`,
      field: 'taxNumber',
      deepLink: `/payroll/employees/${employee.id}#tax-number`,
    });
  }

  if (employee.taxNumber && existingTaxNumbers.includes(employee.taxNumber)) {
    results.push({
      code: 'DUPLICATE_TAX_NUMBER',
      severity: 'error',
      message: `Tax number ${employee.taxNumber} is already used by another employee.`,
      field: 'taxNumber',
      deepLink: `/payroll/employees/${employee.id}#tax-number`,
    });
  }

  if (employee.idNumber && !/^\d{13}$/.test(employee.idNumber)) {
    results.push({
      code: 'INVALID_ID_NUMBER',
      severity: 'error',
      message: `ID number for ${employee.firstName} ${employee.lastName} must be 13 digits.`,
      field: 'idNumber',
      deepLink: `/payroll/employees/${employee.id}#id-number`,
    });
  }

  if (flags.hasBankDetails === false) {
    results.push({
      code: 'MISSING_BANK_DETAILS',
      severity: 'warning',
      message: `${employee.firstName} ${employee.lastName} has no bank details — EFT payment will fail.`,
      field: 'bankDetails',
      deepLink: `/payroll/employees/${employee.id}#bank-details`,
    });
  }

  return results;
}

export function validatePayrollLine(line: {
  taxableIncome: number;
  monthlyPaye: number;
  grossPay: number;
}): ValidationResult[] {
  const results: ValidationResult[] = [];

  if (line.taxableIncome > MONTHLY_THRESHOLD && line.monthlyPaye === 0) {
    results.push({
      code: 'PAYE_ZERO_ON_TAXABLE_INCOME',
      severity: 'warning',
      message:
        'Employee has taxable income above the annual threshold but zero PAYE. Verify tax number and directive.',
      field: 'paye',
    });
  }

  return results;
}


/** Human wording for each input the ETI engine could not find. */
const ETI_MISSING_LABEL: Record<EtiMissingInput, string> = {
  date_of_birth: 'date of birth',
  employment_start_date: 'start date',
};

/**
 * Warn when ETI eligibility could not be DETERMINED for an employee.
 *
 * Severity is 'warning', never 'error': a missing date of birth must not stop
 * anyone being paid. Getting payroll out matters more than the incentive claim,
 * and blocking the run would be a worse regression than the bug this closes.
 *
 * Silent on a genuine determination, eligible or not — that is a finding, not a
 * gap, and warning about it would train people to ignore the warning.
 */
export function validateEti(
  employee: Pick<PayrollEmployee, 'id' | 'firstName' | 'lastName'>,
  eti: Pick<EtiResult, 'isDeterminable' | 'missingInputs'> & Partial<Pick<EtiResult, 'monthlyEti'>>,
  periodDate?: Date,
): ValidationResult[] {
  // ETI claimed on a table nobody has confirmed (pay periods from April 2026).
  if (periodDate && (eti.monthlyEti ?? 0) > 0 && isEtiTableUnconfirmed(periodDate)) {
    return [{
      code: 'ETI_TABLE_UNCONFIRMED',
      severity: 'warning',
      message: `${employee.firstName} ${employee.lastName}: ${ETI_TABLE_UNCONFIRMED_MESSAGE}`,
      field: 'eti',
    }];
  }
  if (eti.isDeterminable || eti.missingInputs.length === 0) return [];

  const fields = eti.missingInputs.map((m) => ETI_MISSING_LABEL[m]);
  const missing = fields.length === 1
    ? `${fields[0]} is missing`
    : `${fields.slice(0, -1).join(', ')} and ${fields[fields.length - 1]} are missing`;

  return [{
    code: 'ETI_INDETERMINATE',
    severity: 'warning',
    message:
      `ETI eligibility could not be determined for ${employee.firstName} ${employee.lastName}`
      + ` — ${missing}. No Employment Tax Incentive has been claimed for this employee.`,
    // Point at the first gap; the message names them all.
    field: eti.missingInputs[0] === 'date_of_birth' ? 'dateOfBirth' : 'startDate',
    deepLink: `/payroll/employees/${employee.id}#${eti.missingInputs[0]!.replace(/_/g, '-')}`,
  }];
}

/**
 * What the employee's terms of work say about how they are taxed (employmentTerms, taxStatusTreatment):
 *  - HOURS_NOT_RECORDED: a monthly employee with no hours is standard employment by default, never silently. Info for a
 *    permanent employee; a WARNING for a contract or casual one, whose hours are the likelier thing to be under 22 a week;
 *  - DAY_PAY_FROM_EARNINGS (warning): the line's earnings per scheduled day differ from the recorded rate and decided the class;
 *  - EMPLOYMENT_UNDETERMINED (error): the guide cannot classify from the terms recorded (G21 p. 28);
 *  - DIRECTOR_STATUS_NOT_SET (error): employment type "director" with tax status "employee": the card asks, nothing
 *    changes silently (grill 24), so the run stops until someone sets one;
 *  - CONTRACTOR_UIF_SDL_IGNORED (warning): a contractor's earnings carry UIF or SDL flags, which are set aside (no UIF or SDL
 *    is taken from a contractor), so the figures are right and the flags are only noise.
 */
export function validateEmploymentTerms(
  employee: Pick<PayrollEmployee, 'id' | 'firstName' | 'lastName' | 'employeeNumber' | 'employmentType' | 'taxStatus'>,
  classification: EmploymentClassification,
  components: readonly EmployeeComponent[],
): ValidationResult[] {
  const name = `${employee.firstName} ${employee.lastName}`.trim();
  const link = { field: 'workTerms', deepLink: `/payroll/employees/${employee.id}#work-terms` };
  const results: ValidationResult[] = [];
  if (classification.hoursNotRecorded) {
    const likelyPartTime = employee.employmentType === 'contract' || employee.employmentType === 'casual';
    results.push({
      code: 'HOURS_NOT_RECORDED', severity: likelyPartTime ? 'warning' : 'info', ...link,
      message: `${name}: ${classification.reason}.${likelyPartTime ? ` A ${employee.employmentType} employee may work under 22 hours a week (non-standard employment, 25% PAYE, G21 p. 28): record the hours.` : ''}`,
    });
  }
  if (classification.dayPayNote) {
    results.push({ code: 'DAY_PAY_FROM_EARNINGS', severity: 'warning', message: `${name}: ${classification.dayPayNote}`, ...link });
  }
  if (classification.kind === 'undetermined') {
    results.push({ code: 'EMPLOYMENT_UNDETERMINED', severity: 'error', message: `${name}: ${classification.reason} Record the terms of work, then recalculate.`, ...link });
  }
  if (employee.employmentType === 'director' && employee.taxStatus === 'employee') {
    results.push({
      code: 'DIRECTOR_STATUS_NOT_SET', severity: 'error',
      message: `${name} (employee ${employee.employeeNumber}) has employment type Director but tax status Employee, so this run cannot be approved. `
        + 'Fix: open the employee profile, go to Work terms, set Tax status to Director, save, then recalculate the run. '
        + 'If the person is not a director, change the employment type instead.',
      ...link,
    });
  }
  const flagged = employee.taxStatus === 'independent_contractor'
    && components.some(c => c.component.componentType === 'earning' && (c.component.isUifApplicable || c.component.isSdlApplicable));
  if (flagged) {
    results.push({
      code: 'CONTRACTOR_UIF_SDL_IGNORED', severity: 'warning',
      message: `${name} is an independent contractor: UIF and SDL are not taken, whatever the earnings' UIF and SDL flags say.`, ...link,
    });
  }
  return results;
}
