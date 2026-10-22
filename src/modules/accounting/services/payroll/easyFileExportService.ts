/**
 * SARS e@syFile IRP5 Export Service
 * Produces a CSV import file that can be loaded into SARS e@syFile Employer.
 *
 * Spec: SARS BRS — PAYE Employer Reconciliation v25.2.0 (effective 1 March 2026).
 *
 * MVP scope:
 *   - IRP5 certificates, and an IT3(a) when no tax was deducted at all (4150
 *     reason 04 with a directive, else 02; BRS V25.3.0 p. 17, 58, 108). No ITREG.
 *   - Natural persons with valid RSA ID (nature-of-person A)
 *   - Income code 3601 (gross salary/wages), and 3605 annual payments (bonus,
 *     leave pay on resignation, notice pay — SARS PAYE-GEN-01-G21 (2027) p. 33:
 *     "Reflect under code 3605"), which 3601 then excludes
 *   - Lump sums paid under a SARS directive, in a run (audit 2026-10-18 P3) or
 *     outside payroll (directivePaymentFiling, PAYE 4a follow-ups G1): the
 *     income code (3901, or 3907 for other lump sums) with its PAYE under 4115
 *     for 3901 (G21 (2027) p. 22) and under 4102 for 3907 (G21 p. 21; BRS
 *     V25.3.0 p. 57 lists the 4115 codes), and the lump-sum directive group
 *     3230 number, 3231 issued date, 3232 income source code, 3233 income
 *     amount (BRS "Directive Information", p. 41–44; the optional 3234 type
 *     indicator is left out). 3601 excludes them.
 *   - Deduction codes 4102 (PAYE), 4115 (PAYE on lump sums), 4141 (total UIF:
 *     employee + employer), 4142 (SDL)
 *   - Periods-of-employment field derived from employee start/end dates
 *
 * Deliberately out of scope — will be added in later iterations:
 *   - The IRP5 total fields (gross remuneration 3699 and its 3696-3698 splits,
 *     4149 total tax/UIF/SDL): their exact definitions need the BRS in hand, so
 *     they are not guessed. Do not submit this file without checking e@syFile's
 *     import validation for them.
 *   - Reason codes 4150 other than 02 and 04 (08 needs 4116, not emitted).
 *   - ETI (codes 3026, 3190, 7002-7009)
 *   - Foreign nationals / passport / alternate ID (codes 3061/3090/3100)
 *   - Fixed-rate PAYE directives
 *   - Fringe benefits and allowances (codes 3701-3713, 3801-3815)
 *   - Non-natural persons / directors / asylum seekers
 *
 * The service throws UsageError on missing employer data so the caller can
 * surface a clear remediation message to the user.
 */

import { UsageError, formatField, isValidPayeRef, isValidSdlRef, isValidUifRef, isValidTaxNumber } from './easyFileFields';
import { validateEmployee } from './easyFileEmployeeChecks';
import { lumpSumPayeCode } from './payrollLumpSumFiling';
import { validateCertificateTaxFields } from './irp5ValidationEngine';

export { UsageError, formatField, isValidPayeRef, isValidSdlRef, isValidUifRef, isValidTaxNumber };
export { splitCertificateIncome } from './payrollLumpSumFiling';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EmployerInput {
  tradingName: string;            // 2010
  payeReferenceNumber: string;    // 2020
  sdlReferenceNumber: string | null;  // 2022
  uifReferenceNumber: string | null;  // 2024
  contactFirstName: string;       // 2025
  contactSurname: string;         // 2036
  contactBusinessPhone: string | null; // 2026
  contactCellPhone: string | null;     // 2040
  contactEmail: string | null;    // 2027
  transactionYear: number;        // 2030 (CCYY)
  reconciliationPeriod: number;   // 2031 (CCYYMM — 02 for annual, 08 for interim)
  sic7Code: string | null;        // 2082
  physicalStreet: string;         // 2064
  physicalSuburb: string | null;  // 2065
  physicalCity: string | null;    // 2066
  physicalPostalCode: string;     // 2080
}

export interface EmployeeInput {
  certificateNumber: string;      // 3010 — must be 30 characters exactly
  yearOfAssessment: number;       // 3025 (CCYY)
  surname: string;                // 3030
  firstNames: string;             // 3040 — first two names
  initials: string;               // 3050
  idNumber: string;               // 3060 — 13-digit RSA ID
  taxNumber: string | null;       // 3150 — 10-digit SARS income tax ref (optional if legitimate)
  employmentStartDate: string;    // 3200 — CCYYMMDD
  employmentEndDate: string | null; // 3210 — CCYYMMDD
  periodsInYoA: number;           // 3215 — e.g. months worked in the year (0..12)
  // Amounts (Rand, cents dropped where applicable):
  grossSalary3601: number;        // 3601 — cents dropped
  paye4102: number;               // 4102 — cents kept (N11.2)
  uifEmployee: number;            // part of 4141 (total UIF) — cents kept
  uifEmployer: number;            // part of 4141 (total UIF) — cents kept
  sdl4142: number;                // 4142 (SDL) — cents kept
  /** Annual payments (3605), NOT included in grossSalary3601. Their PAYE stays in 4102. */
  annualPayments3605?: number;
  /** Lump sums paid under a directive, NOT included in grossSalary3601. */
  lumpSums?: LumpSumInput[];
  /**
   * The employee's tax threshold for the year (by age). An IT3(a) with reason 02
   * ("earn less than the tax threshold") is written only when 3601 + 3605 is at
   * or under it; without it, or above it, a certificate with no tax is refused.
   */
  taxThreshold?: number;
}

export interface LumpSumInput {
  sourceCode: string;             // income code, and 3232
  directiveNumber: string;        // 3230 — AN15, numeric for 3901
  directiveIssuedDate: string;    // 3231 — CCYYMMDD
  amount: number;                 // the income code and 3233 — cents dropped
  paye: number;                   // part of 4115 — cents kept
}

export interface BuildInput {
  employer: EmployerInput;
  employees: EmployeeInput[];
}

// ─── Record builders ──────────────────────────────────────────────────────────

function validateEmployer(e: EmployerInput): void {
  if (!e.tradingName.trim()) throw new UsageError('Employer trading name (code 2010) is required');
  if (!isValidPayeRef(e.payeReferenceNumber)) {
    throw new UsageError('Employer PAYE reference number (code 2020) is invalid — expected 10 digits starting with 7 (or 0/1/2/3/9 if not registered for PAYE)');
  }
  if (e.sdlReferenceNumber && !isValidSdlRef(e.sdlReferenceNumber)) {
    throw new UsageError('Employer SDL reference number (code 2022) must be "L" + 9 digits');
  }
  if (e.uifReferenceNumber && !isValidUifRef(e.uifReferenceNumber)) {
    throw new UsageError('Employer UIF reference number (code 2024) must be "U" + 9 digits');
  }
  if (!e.contactFirstName.trim()) throw new UsageError('Employer contact first name (code 2025) is required');
  if (!e.contactSurname.trim()) throw new UsageError('Employer contact surname (code 2036) is required');
  if (!e.contactBusinessPhone && !e.contactCellPhone) {
    throw new UsageError('Employer contact requires either a business phone (2026) or a cell phone (2040)');
  }
  if (e.transactionYear < 1999) throw new UsageError('Transaction year (code 2030) must be 1999 or later');
  if (!/^[12][0-9]{3}(02|08)$/.test(String(e.reconciliationPeriod))) {
    throw new UsageError('Reconciliation period (code 2031) must be CCYYMM with MM = 02 (annual) or 08 (interim)');
  }
  if (!e.physicalStreet.trim()) throw new UsageError('Employer physical street/farm (code 2064) is required');
  if (!e.physicalSuburb && !e.physicalCity) {
    throw new UsageError('Employer physical address requires either a suburb (2065) or a city (2066)');
  }
  if (!/^\d{4}$/.test(e.physicalPostalCode) || e.physicalPostalCode === '0000') {
    throw new UsageError('Employer physical postal code (code 2080) must be 4 digits and not 0000');
  }
  if (e.sic7Code && !/^\d{5}$/.test(e.sic7Code)) {
    throw new UsageError('Employer SIC7 code (code 2082) must be 5 digits');
  }
}

export function buildEmployerRecord(e: EmployerInput): string[] {
  validateEmployer(e);
  const lines: (string | null)[] = [
    formatField(2010, e.tradingName, 'FT'),
    formatField(2015, 'LIVE', 'A'),
    formatField(2020, e.payeReferenceNumber, 'AN'),
    formatField(2022, e.sdlReferenceNumber, 'AN'),
    formatField(2024, e.uifReferenceNumber, 'AN'),
    formatField(2025, e.contactFirstName, 'A'),
    formatField(2036, e.contactSurname, 'A'),
    formatField(2026, e.contactBusinessPhone, 'AN'),
    formatField(2040, e.contactCellPhone, 'AN'),
    formatField(2027, e.contactEmail, 'FT'),
    formatField(2028, 'IsaFlow', 'FT'),
    formatField(2029, 'IsaFlow Payroll', 'FT'),
    formatField(2030, e.transactionYear, 'N'),
    formatField(2031, e.reconciliationPeriod, 'N'),
    formatField(2082, e.sic7Code, 'AN'),
    formatField(2037, 'N', 'A'),
    formatField(2064, e.physicalStreet, 'FT'),
    formatField(2065, e.physicalSuburb, 'FT'),
    formatField(2066, e.physicalCity, 'FT'),
    formatField(2080, e.physicalPostalCode, 'AN'),
    formatField(2081, 'ZA', 'A'),
    formatField(9999, 'N4', 'N'),
  ];
  // Replace the placeholder 9999 with the fixed "9999,9999" terminator so the
  // record count stays truthful.
  lines[lines.length - 1] = '9999,9999';
  return lines.filter((l): l is string => l !== null);
}

/** One income line per lump-sum source code, in code order, amounts summed. */
function lumpIncome(lumpSums: LumpSumInput[]): (string | null)[] {
  const byCode = new Map<string, number>();
  for (const l of lumpSums) byCode.set(l.sourceCode, (byCode.get(l.sourceCode) ?? 0) + l.amount);
  return [...byCode.keys()].sort().map(code => formatField(Number(code), byCode.get(code)!, 'N'));
}

/**
 * Reason 02 is a statement to SARS that the employee earned less than the tax
 * threshold. Nil PAYE above it (medical credits: reason 08, which needs 4116,
 * not produced; or a payroll error) has no reason this file can state.
 */
function assertUnderThreshold(emp: EmployeeInput): void {
  const income = Math.max(0, emp.grossSalary3601) + Math.max(0, emp.annualPayments3605 ?? 0);
  if (emp.taxThreshold != null && income <= emp.taxThreshold) return;
  throw new UsageError(`${emp.surname} (certificate ${emp.certificateNumber}): no PAYE was deducted on R${income.toFixed(2)} `
    + (emp.taxThreshold == null
      ? 'and the tax threshold is not known (capture the employee\'s date of birth or ID number: the threshold depends on age), '
      : `which is above the tax threshold of R${emp.taxThreshold.toFixed(2)}, `)
    + 'so no reason for non-deduction (4150) can be stated: 02 is only for income under the threshold, and 08 (medical credits) '
    + 'needs code 4116, which this file does not produce. Check the payroll, or file this certificate by hand.');
}

export function buildEmployeeRecord(emp: EmployeeInput): string[] {
  validateEmployee(emp);
  const lumpSums = emp.lumpSums ?? [];
  const under4115 = lumpSums.filter(l => lumpSumPayeCode(l.sourceCode) === '4115');
  const paye4115 = Math.round(under4115.reduce((t, l) => t + l.paye, 0) * 100) / 100;
  // No tax at all: an IT3(a) with a reason code instead of the tax fields (BRS
  // V25.3.0 p. 17, 3015). 04 "non-taxable earnings, including nil directives"
  // when a directive is on it (valid only then, p. 58), else 02 "earn less than
  // the tax threshold" (p. 108).
  const it3a = emp.paye4102 <= 0 && paye4115 <= 0;
  // Lump sums are outside 3601/3605: a nil directive beside taxable pay over the threshold is no reason 04 either.
  if (it3a) assertUnderThreshold(emp);
  const lines: (string | null)[] = [
    formatField(3010, emp.certificateNumber, 'AN'),
    formatField(3015, it3a ? 'IT3(a)' : 'IRP5', 'AN'),
    formatField(3020, 'A', 'A'),
    formatField(3025, emp.yearOfAssessment, 'N'),
    formatField(3030, emp.surname, 'FT'),
    formatField(3040, emp.firstNames, 'AN'),
    formatField(3050, emp.initials, 'A'),
    formatField(3060, emp.idNumber, 'N'),
    formatField(3150, emp.taxNumber, 'AN'),
    formatField(3200, emp.employmentStartDate, 'N'),
    formatField(3210, emp.employmentEndDate, 'N'),
    // 3215 — N4.4 periods in YoA. Render with 4-decimal precision per BRS.
    `3215,${emp.periodsInYoA.toFixed(4)}`,
    ...lumpSums.flatMap(l => [
      formatField(3230, l.directiveNumber, 'AN'),
      formatField(3231, l.directiveIssuedDate, 'N'),
      formatField(3232, l.sourceCode, 'N'),
      formatField(3233, l.amount, 'N'),
    ]),
    formatField(3601, emp.grossSalary3601 > 0 ? emp.grossSalary3601 : null, 'N'),
    formatField(3605, (emp.annualPayments3605 ?? 0) > 0 ? emp.annualPayments3605! : null, 'N'),
    ...lumpIncome(lumpSums),
    it3a ? null : formatField(4102, emp.paye4102, 'N_CENTS'),
    // 4115 only for 3901 / 3915 / 3920-3924 (lumpSumPayeCode); a 3907's PAYE is in 4102.
    !it3a && under4115.length > 0 ? formatField(4115, paye4115, 'N_CENTS') : null,
    // 4141 is ONE field: the employee's and the employer's UIF together.
    formatField(4141, Math.round((emp.uifEmployee + emp.uifEmployer) * 100) / 100, 'N_CENTS'),
    formatField(4142, emp.sdl4142, 'N_CENTS'),
    it3a ? `4150,${lumpSums.length > 0 ? '04' : '02'}` : null,
    '9999,9999',
  ];
  const record = lines.filter((l): l is string => l !== null);
  const broken = validateCertificateTaxFields(record);
  if (broken.length > 0) {
    throw new UsageError(`${emp.surname} (certificate ${emp.certificateNumber}): ${broken.map(m => m.message).join(' ')}`);
  }
  return record;
}

export function buildTrailerRecord(recordCount: number): string[] {
  // 6010 = count of records excluding the trailer itself (i.e. employer 2010
  // + all employee 3010 records).
  return [
    `6010,${recordCount}`,
    '9999,9999',
  ];
}

export function buildIrp5File(input: BuildInput): string {
  if (input.employees.length === 0) {
    throw new UsageError('Cannot build an IRP5 file with zero employees');
  }
  const lines: string[] = [];
  lines.push(...buildEmployerRecord(input.employer));
  for (const emp of input.employees) {
    lines.push(...buildEmployeeRecord(emp));
  }
  const recordCount = 1 + input.employees.length; // 2010 + each 3010
  lines.push(...buildTrailerRecord(recordCount));
  // BRS §3 file is newline-delimited. Use CRLF — e@syFile Thin Client accepts
  // both but CRLF is what the reference importer samples produce.
  return lines.join('\r\n');
}

/**
 * SARS requires the certificate number to be 30 characters:
 *   10 digits PAYE ref + 4 digits transaction year CCYY + 2 digits reconciliation period MM + 14 alphanumeric unique suffix (left-padded with zeros).
 */
export function buildCertificateNumber(
  payeRef: string,
  transactionYear: number,
  reconciliationMonthMM: 2 | 8,
  uniqueSuffix: string | number,
): string {
  if (!/^\d{10}$/.test(payeRef)) {
    throw new UsageError('PAYE ref must be 10 digits to build a certificate number');
  }
  const yr = String(transactionYear).padStart(4, '0');
  const mm = String(reconciliationMonthMM).padStart(2, '0');
  const suffix = String(uniqueSuffix).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (suffix.length > 14) {
    throw new UsageError('Unique suffix for certificate number cannot exceed 14 characters');
  }
  return `${payeRef}${yr}${mm}${suffix.padStart(14, '0')}`;
}
