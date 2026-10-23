/**
 * The medical fields of an e@syFile employee record, and the reason a
 * certificate with no tax gives for it (4150). PAYE 4a follow-ups round 2, R3
 * (Hein 2026-10-23, option A). SARS BRS PAYE Employer Reconciliation V25.3.0
 * (Jun-26):
 * - 4005 (p. 52-53; p. 101 "Medical scheme fees (contributions) paid and
 *   'deemed paid' by employee"): cents omitted. Here: the fees the employee
 *   paid through payroll, deductions coded 4005. The 'deemed paid' part, an
 *   employer's contribution taxed as a 3810 benefit (G21 2027 p. 11), is not
 *   supported.
 * - 4116 (p. 59): "Medical Scheme Fees Tax Credit considered by employer for
 *   PAYE purposes"; IRP5 or IT3(a); "mandatory if any value is completed for
 *   ... 4005" and "must not be completed if there is no value for ... 4005";
 *   may be 0.00; cents kept (p. 7, rule j).
 * - 4120 (p. 59-60): "Additional Medical Expenses Tax Credit if employee ≥65
 *   allowed by Employer for PAYE purposes"; mandatory with 4005 for an employee
 *   65 or older, never under 65; may be 0.00; cents kept.
 * - 4150 (p. 61, 108): 02 "earn less than the tax threshold"; 04 "non-taxable
 *   earnings, including nil directives", from 2024 only with the directive
 *   information; 08 "No Tax to be withheld due to Medical Scheme Fees Tax
 *   Credit allowed ... and/or Additional Medical Expenses Tax Credit if
 *   employee ≥65 allowed", "only valid from 2017 year of assessment and if codes
 *   4116 and/ or 4120 has been completed". 08 is given only when one of them is
 *   above nil (Hein 2026-10-23): a nil credit removed no tax.
 * - 4149 excludes 4116 and 4120 (p. 108); 4149 is not emitted.
 * The 65 test is age on the last day of the year of assessment (SARS Guide on
 * the Determination of Medical Tax Credits, Issue 18, p. 2).
 */

import { UsageError, formatField } from './easyFileFields';
import type { EmployeeInput } from './easyFileExportService';
import { birthFromIdNumber } from './easyFileEmployeeFacts';
import { getAge } from './payeEngine';

export interface MedicalCertificateInput {
  /** Medical scheme fees paid through payroll in the year (4005). */
  fees: number;
  /** Medical scheme fees tax credit the PAYE took into account (4116). */
  credit: number;
  /** Additional medical expenses tax credit the PAYE took into account (4120; 65 and older only). */
  additionalCredit: number;
  /** 65 or older on the last day of the year of assessment. */
  age65OrOlder: boolean;
  /** False when the latest taxed month was calculated before IsaFlow recorded the credits (payrollMedicalRecord). */
  recorded: boolean;
}

const cents = (n: number): number => Math.round(Math.max(0, n) * 100) / 100;

/** Whether 4005/4116 (and 4120) go on the certificate: only beside a 4005 value, and only when the credits are known. */
function reportable(m: MedicalCertificateInput | undefined): m is MedicalCertificateInput {
  return m != null && m.recorded && Math.floor(m.fees) > 0;
}

/** 4005 (a deduction code, before 4102) and the credits 4116 and, for 65 and older, 4120 (after 4115); or none. */
export function medicalFieldLines(emp: EmployeeInput): { fees: (string | null)[]; credits: (string | null)[] } {
  const m = emp.medical;
  if (!reportable(m)) return { fees: [], credits: [] };
  return {
    fees: [formatField(4005, m.fees, 'N')],
    credits: [
      formatField(4116, cents(m.credit), 'N_CENTS'),
      m.age65OrOlder ? formatField(4120, cents(m.additionalCredit), 'N_CENTS') : null,
    ],
  };
}

/**
 * The 4150 reason of a certificate with no tax: 02 / 04 only for pay at or
 * under the tax threshold, 08 above it when a medical credit took the tax off
 * and is on the certificate; anything else has no reason this file can state.
 */
export function nilTaxReason(emp: EmployeeInput): '02' | '04' | '08' {
  const income = Math.max(0, emp.grossSalary3601) + Math.max(0, emp.annualPayments3605 ?? 0);
  const lumpSums = emp.lumpSums ?? [];
  if (emp.taxThreshold != null && income <= emp.taxThreshold) return lumpSums.length > 0 ? '04' : '02';
  const m = emp.medical;
  if (reportable(m) && (cents(m.credit) > 0 || (m.age65OrOlder && cents(m.additionalCredit) > 0))) return '08';
  const who = `${emp.surname} (certificate ${emp.certificateNumber})`;
  const why = emp.taxThreshold == null
    ? 'and the tax threshold is not known (it needs the employee\'s age, from the date of birth or ID number, and the tax tables of that year), '
    : `which is above the tax threshold of R${emp.taxThreshold.toFixed(2)}, `;
  throw new UsageError(`${who}: no PAYE was deducted on R${income.toFixed(2)} ${why}`
    + (lumpSums.length > 0 ? 'beside a nil-tax directive, ' : '')
    + 'so no reason for non-deduction (4150) can be stated: 02 and 04 are only for pay under the threshold, and 08 (medical credits) '
    + `needs the medical scheme fees tax credit (4116) beside the medical aid contributions (4005). ${medicalGap(m)}`
    + 'Check the payroll, or file this certificate by hand.');
}

function medicalGap(m: MedicalCertificateInput | undefined): string {
  if (m != null && !m.recorded) {
    return 'The latest month was calculated before IsaFlow recorded the medical credits, so they are not known. ';
  }
  if (m == null || Math.floor(m.fees) <= 0) {
    return 'No medical aid contribution is deducted through payroll for this employee (a deduction component coded 4005); '
      + 'employer-paid medical aid (a 3810 benefit) is not supported. ';
  }
  return 'No medical credit took tax off this year. ';
}

/** The date of birth a record states: 3080 (CCYYMMDD), else the RSA ID number 3060; null when neither reads. */
function recordBirth(field: Map<string, string>): Date | null {
  const dob = /^(\d{4})(\d{2})(\d{2})$/.exec(field.get('3080') ?? '');
  if (dob) return new Date(Number(dob[1]), Number(dob[2]) - 1, Number(dob[3]));
  return birthFromIdNumber(field.get('3060'));
}

/**
 * BRS V25.3.0 p. 59-61, on one record's fields: 4116 and 4120 only beside a
 * 4005 value, 4116 with every 4005; 4120 "validate to Date of Birth (code
 * 3080)": never under 65, mandatory with 4005 for 65 and older (age on the last
 * day of the year of assessment, 3025; the date of birth from 3080, else the
 * ID number, since IsaFlow does not emit 3080); 4150 = 08 only with 4116 or
 * 4120 above nil (Hein 2026-10-23: a nil credit removed no tax).
 */
export function medicalFieldRules(field: Map<string, string>, err: (code: string, message: string) => void): void {
  const fees = Number(field.get('4005')) > 0;
  if ((field.has('4116') || field.has('4120')) && !fees) {
    err('MEDICAL_CREDIT_WITHOUT_4005', 'The medical credits (4116, 4120) need the medical scheme contributions (4005).');
  }
  if (fees && !field.has('4116')) {
    err('MEDICAL_FEES_WITHOUT_4116', 'Medical scheme contributions (4005) need the medical scheme fees tax credit (4116, 0.00 if nil).');
  }
  const born = recordBirth(field);
  const year = Number(field.get('3025'));
  if (born && year > 0) {
    const age = getAge(born, new Date(year, 2, 0));
    if (age < 65 && field.has('4120')) err('MEDICAL_4120_UNDER_65', `4120 is only for an employee 65 or older; this one is ${age}.`);
    if (age >= 65 && fees && !field.has('4120')) err('MEDICAL_4120_MISSING', `An employee of ${age} with 4005 needs 4120 (0.00 if nil).`);
  }
  const reason = field.get('4150');
  if (reason != null && Number(reason) === 8 && !(Number(field.get('4116')) > 0 || Number(field.get('4120')) > 0)) {
    err('REASON_08_WITHOUT_MEDICAL_CREDIT', 'Reason code 08 (medical credits) needs a medical credit above nil (4116 or 4120).');
  }
}

/**
 * What the export tells the user about an employee's medical fields
 * (X-IsaFlow-Warnings; round 2 review): fees whose credits are unknown (the
 * latest month predates the record); a credit PAYE took with no 4005 deducted
 * (employer-paid or privately paid medical aid: SARS takes 4116 only beside
 * 4005, so neither is on the certificate); and an employee 65 or older by the ID
 * number with no date of birth on the payroll record (PAYE took the age from
 * the date of birth only, so none of the 65+ rebates or credit was given).
 */
export function medicalCertificateWarnings(
  who: string,
  record: { fees: number; credit: number; additionalCredit: number; recorded: boolean } | undefined,
  person: { age: number | null; dateOfBirthMissing: boolean },
): string[] {
  const out: string[] = [];
  if (record && !record.recorded && record.fees > 0) {
    out.push(`${who}: medical aid contributions (4005) and the medical credits (4116/4120) are not on the certificate: `
      + 'the latest month was calculated before IsaFlow recorded the credits. Add them in e@syFile.');
  }
  if (record && record.credit > 0 && Math.floor(record.fees) <= 0) {
    out.push(`${who}: PAYE took R${record.credit.toFixed(2)} of medical scheme fees tax credit, but no medical aid contribution is `
      + 'deducted through payroll (a deduction coded 4005), so 4005 and 4116 are not on the certificate (SARS takes 4116 only beside 4005). '
      + 'If the employer or the employee pays the scheme directly, add both in e@syFile.');
  }
  if (person.dateOfBirthMissing && person.age != null && person.age >= 65) {
    out.push(`${who}: no date of birth on the payroll record, but the ID number makes the employee ${person.age}: PAYE was `
      + 'calculated without the 65+ rebates and medical credit. Add the date of birth and check the year\'s PAYE.');
  }
  return out;
}
