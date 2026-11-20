/**
 * e@syFile employee-record checks (SARS BRS PAYE Employer Reconciliation, see
 * easyFileExportService). Extracted from that file to keep it under the
 * 300-line cap.
 */

import { UsageError } from './easyFileFields';
import type { EmployeeInput } from './easyFileExportService';
import { fieldLabel } from './easyFileCertificateCodes';
import { localCCYYMMDD } from './easyFileEmployeeFacts';

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
  // BRS V25.3.0 p. 27: for nature of person A the income tax reference starts with 0, 1, 2 or 3 (9 is a company's).
  // BRS p. 27: "Must not contain ONLY zeros".
  if (emp.taxNumber && /^0+$/.test(emp.taxNumber)) {
    throw new UsageError(`${fieldLabel('incomeTaxReference', 'Income tax reference number')} must not be only zeros: "${emp.taxNumber}"`);
  }
  if (emp.taxNumber && !/^[0-3]\d{9}$/.test(emp.taxNumber)) {
    throw new UsageError(`${fieldLabel('incomeTaxReference', 'Income tax reference number')} must be 10 digits starting with 0, 1, 2 or 3: "${emp.taxNumber}"`);
  }
  // BRS p. 32: CCYYMMDD, start <= end, start on or after 1 January of the year before the year of assessment.
  for (const [name, words, v] of [['taxPeriodStart', 'Certificate tax period start date', emp.taxPeriodStart],
    ['taxPeriodEnd', 'Certificate tax period end date', emp.taxPeriodEnd]] as const) {
    if (!/^\d{8}$/.test(v)) throw new UsageError(`${fieldLabel(name, words)} must be CCYYMMDD: "${v}"`);
  }
  if (emp.taxPeriodStart > emp.taxPeriodEnd) {
    throw new UsageError(`${fieldLabel('taxPeriodStart', 'Certificate tax period start date')} ${emp.taxPeriodStart} is after the end date (code 3180) ${emp.taxPeriodEnd}`);
  }
  if (emp.taxPeriodStart < `${emp.yearOfAssessment - 1}0101`) {
    throw new UsageError(`${fieldLabel('taxPeriodStart', 'Certificate tax period start date')} ${emp.taxPeriodStart} is before 1 January ${emp.yearOfAssessment - 1}`);
  }
  // BRS p. 33: N3.4 (at most 999.9999); 3210 cannot be greater than 3200.
  if (emp.payPeriodsInYear > 999.9999) {
    throw new UsageError(`${fieldLabel('payPeriodsInYear', 'Pay periods in the year')} must be at most 999.9999: ${emp.payPeriodsInYear}`);
  }
  if (!(emp.payPeriodsInYear > 0) || !(emp.payPeriodsWorked > 0) || emp.payPeriodsWorked > emp.payPeriodsInYear) {
    throw new UsageError(`${fieldLabel('payPeriodsWorked', 'Pay periods worked')} must be more than 0 and not more than `
      + `the pay periods in the year (code 3200): ${emp.payPeriodsWorked} of ${emp.payPeriodsInYear}`);
  }
  const lumpSums = emp.lumpSums ?? [];
  if (emp.grossSalary3601 <= 0 && (emp.annualPayments3605 ?? 0) <= 0 && (emp.independentContractor3616 ?? 0) <= 0 && !lumpSums.some(l => l.amount > 0)
    // As the writer: a benefit under R1 writes nothing (cents dropped, a nil field left out).
    && !(emp.fringeBenefits ?? []).some(f => Math.floor(f.amount) >= 1)
    && !(emp.cashAllowances ?? []).some(f => Math.floor(f.amount) >= 1)) {
    throw new UsageError('At least one income code must be greater than zero — 3601 (gross salary), 3605, 3616 (contractor income), a fringe benefit or a lump sum must be > 0 for an IRP5');
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

/**
 * BRS V25.3.0 p. 26 (3100): the income tax reference is mandatory on an IRP5 with PAYE (4102) above zero, and on an
 * IT3(a) whose reason (4150) is not 02 or 04; optional otherwise. Refused here, naming the employee, because
 * e@syFile rejects the certificate without it.
 */
export function assertIncomeTaxReference(emp: EmployeeInput, it3aReason: string | null): void {
  if (emp.taxNumber) return;
  const required = it3aReason === null ? emp.paye4102 > 0 : it3aReason !== '02' && it3aReason !== '04';
  if (!required) return;
  const why = it3aReason === null ? 'PAYE was withheld' : `the IT3(a) reason is ${it3aReason}`;
  throw new UsageError(`${emp.surname} (certificate ${emp.certificateNumber}): ${fieldLabel('incomeTaxReference', 'income tax reference number')} `
    + `is required because ${why}. Capture the employee's tax number on the employee record.`);
}

const fromCCYYMMDD = (d: string): Date => new Date(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)));
const displayDay = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** BRS V25.3.0 p. 32 (3180): "cannot be greater than the current date plus 30 days" (local calendar days). */
export function latestTaxPeriodEnd(asOf: Date): string {
  const d = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate() + 30);
  return localCCYYMMDD(d);
}

/** The first day a certificate whose tax period ends on `end` may be filed (30 days before it), YYYY-MM-DD. */
export function earliestFilingDay(end: string): string {
  const e = fromCCYYMMDD(end);
  return displayDay(new Date(e.getFullYear(), e.getMonth(), e.getDate() - 30));
}

/**
 * BRS V25.3.0 p. 32 (3180, annual and interim alike): e@syFile refuses a file while a certificate's tax period ends
 * more than 30 days after today. The message naming the first day the file can be built; null when it can be now.
 */
export function filingDateMessage(employees: ReadonlyArray<Pick<EmployeeInput, 'taxPeriodEnd'>>, kind: 'annual' | 'interim',
  transactionYear: number, asOf: Date): string | null {
  const lastEnd = latestTaxPeriodEndOf(employees);
  if (!lastEnd || lastEnd <= latestTaxPeriodEnd(asOf)) return null;
  return `The ${kind} e@syFile file for tax year ${transactionYear} can be filed from ${earliestFilingDay(lastEnd)}: SARS refuses a `
    + `certificate tax period (code 3180) ending more than 30 days after today (BRS V25.3.0 p. 32), and this period ends on ${lastEnd}.`;
}

const latestTaxPeriodEndOf = (employees: ReadonlyArray<Pick<EmployeeInput, 'taxPeriodEnd'>>): string | undefined =>
  employees.map(e => e.taxPeriodEnd).sort().at(-1);

/** The ad-hoc export's short warning (it travels in a size-capped header): null when the file can be filed now. */
export function filingDateWarning(employees: ReadonlyArray<Pick<EmployeeInput, 'taxPeriodEnd'>>, asOf: Date): string | null {
  const lastEnd = latestTaxPeriodEndOf(employees);
  if (!lastEnd || lastEnd <= latestTaxPeriodEnd(asOf)) return null;
  return `e@syFile will refuse this file until ${earliestFilingDay(lastEnd)}: its tax period (code 3180) ends more than 30 days from today (BRS V25.3.0 p. 32).`;
}
