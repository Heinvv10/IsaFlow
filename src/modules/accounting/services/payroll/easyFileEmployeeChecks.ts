/**
 * e@syFile employee-record checks (SARS BRS PAYE Employer Reconciliation, see
 * easyFileExportService). Extracted from that file to keep it under the
 * 300-line cap.
 */

import { UsageError, isValidTaxNumber } from './easyFileFields';
import type { EmployeeInput } from './easyFileExportService';

/**
 * BRS V25.3.0 p. 43 (3232): a directive for these income codes has a numeric
 * number; any other (3907, 3908, 3608, ...) is AN15.
 */
const NUMERIC_DIRECTIVE_CODES = new Set([
  '3603', '3653', '3610', '3660', '3623', '3673', '3901', '3951', '3902', '3952', '3903', '3953', '3904', '3954',
  '3905', '3955', '3909', '3915', '3920', '3921', '3922', '3923', '3924', '3926',
]);

export function validateEmployee(emp: EmployeeInput): void {
  if (emp.certificateNumber.length !== 30) {
    throw new UsageError(`Certificate number (code 3010) must be exactly 30 characters: "${emp.certificateNumber}" (${emp.certificateNumber.length})`);
  }
  if (!/^[A-Z0-9]{30}$/.test(emp.certificateNumber)) {
    throw new UsageError('Certificate number (code 3010) must be uppercase letters and digits only');
  }
  if (!/^\d{13}$/.test(emp.idNumber)) {
    throw new UsageError(`ID number (code 3060) must be 13 digits for natural persons: "${emp.idNumber}"`);
  }
  if (emp.taxNumber && !isValidTaxNumber(emp.taxNumber)) {
    throw new UsageError('Tax number (code 3150) must be 10 digits starting with 0/1/2/3/9');
  }
  if (!/^\d{8}$/.test(emp.employmentStartDate)) {
    throw new UsageError('Employment start date (code 3200) must be CCYYMMDD');
  }
  if (emp.employmentEndDate && !/^\d{8}$/.test(emp.employmentEndDate)) {
    throw new UsageError('Employment end date (code 3210) must be CCYYMMDD');
  }
  if (emp.periodsInYoA < 0 || emp.periodsInYoA > 12) {
    throw new UsageError('Periods in year of assessment (code 3215) must be 0..12');
  }
  const lumpSums = emp.lumpSums ?? [];
  if (emp.grossSalary3601 <= 0 && (emp.annualPayments3605 ?? 0) <= 0 && !lumpSums.some(l => l.amount > 0)) {
    throw new UsageError('At least one income code must be greater than zero — 3601 (gross salary), 3605 or a lump sum must be > 0 for an IRP5');
  }
  const who = `${emp.surname} (certificate ${emp.certificateNumber})`;
  for (const l of lumpSums) {
    // BRS V25.3.0 code 3230 (p. 41, 43): AN15, not zeros; numeric only for 3901 and the fund codes.
    const numeric = NUMERIC_DIRECTIVE_CODES.has(l.sourceCode);
    if (!(numeric ? /^\d{1,15}$/ : /^[A-Za-z0-9]{1,15}$/).test(l.directiveNumber) || /^0+$/.test(l.directiveNumber)) {
      throw new UsageError(`Directive number (code 3230) of the ${l.sourceCode} lump sum for ${who} must be up to 15 `
        + `${numeric ? 'digits' : 'letters or digits'} and not zeros: "${l.directiveNumber}". Correct the number on the tax directive.`);
    }
    if (!/^\d{8}$/.test(l.directiveIssuedDate)) {
      throw new UsageError(`Directive issued date (code 3231) of the ${l.sourceCode} lump sum for ${who} must be CCYYMMDD`);
    }
  }
}
