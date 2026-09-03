import type { EtiMissingInput, EtiResult, PayrollEmployee, ValidationResult } from './payrollTypes';

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
  eti: Pick<EtiResult, 'isDeterminable' | 'missingInputs'>,
): ValidationResult[] {
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
