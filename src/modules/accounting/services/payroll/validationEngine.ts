import type { PayrollEmployee, ValidationResult } from './payrollTypes';

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
