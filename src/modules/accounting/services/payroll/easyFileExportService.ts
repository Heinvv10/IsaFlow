/**
 * SARS e@syFile IRP5 Export Service
 * Produces a CSV import file that can be loaded into SARS e@syFile Employer.
 *
 * Spec: SARS BRS — PAYE Employer Reconciliation v25.2.0 (effective 1 March 2026).
 *
 * MVP scope:
 *   - IRP5 certificates only (no IT3(a), no ITREG)
 *   - Natural persons with valid RSA ID (nature-of-person A)
 *   - Income code 3601 (gross salary/wages)
 *   - Deduction codes 4102 (PAYE), 4141 (UIF emp), 4142 (UIF empr), 4150 (SDL)
 *   - Periods-of-employment field derived from employee start/end dates
 *
 * Deliberately out of scope — will be added in later iterations:
 *   - ETI (codes 3026, 3190, 7002-7009)
 *   - Foreign nationals / passport / alternate ID (codes 3061/3090/3100)
 *   - Tax directives (code 3220)
 *   - Fringe benefits, allowances, lump sums (codes 3605, 3701-3713, 3801-3815)
 *   - Non-natural persons / directors / asylum seekers
 *
 * The service throws UsageError on missing employer data so the caller can
 * surface a clear remediation message to the user.
 */

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

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
  uifEmployee4141: number;        // 4141 — cents kept
  uifEmployer4142: number;        // 4142 — cents kept
  sdl4150: number;                // 4150 — cents kept
}

export interface BuildInput {
  employer: EmployerInput;
  employees: EmployeeInput[];
}

// ─── Field formatters ─────────────────────────────────────────────────────────

type FieldType = 'A' | 'AN' | 'FT' | 'N' | 'N_CENTS';

/** BRS §3: no commas or pipes are allowed inside values (rule h). */
function assertNoForbiddenChars(value: string, code: number): void {
  if (value.includes(',') || value.includes('|')) {
    throw new UsageError(`Field ${code} contains a forbidden character (comma or pipe): "${value}"`);
  }
}

/** BRS §3(m): data fields cannot start with a space. */
function assertNoLeadingSpace(value: string, code: number): void {
  if (value.startsWith(' ')) {
    throw new UsageError(`Field ${code} must not start with a space: "${value}"`);
  }
}

export function formatField(code: number, value: string | number | null, type: FieldType): string | null {
  if (value === null || value === undefined || value === '') return null;

  if (type === 'A' || type === 'AN' || type === 'FT') {
    const str = String(value);
    assertNoForbiddenChars(str, code);
    assertNoLeadingSpace(str, code);
    // BRS §3(l): Alpha / AN / FT wrapped in opening + closing double quotes.
    return `${code},"${str}"`;
  }

  if (type === 'N_CENTS') {
    // Cents must be present with a decimal point (§3 and code-level rules for 4101/4102/4115/4141/4142/...).
    const num = Number(value);
    if (num < 0) throw new UsageError(`Field ${code} cannot be negative (BRS §3(g))`);
    return `${code},${num.toFixed(2)}`;
  }

  // Plain numeric — cents dropped, integer only (BRS §3(j)).
  const num = Number(value);
  if (num < 0) throw new UsageError(`Field ${code} cannot be negative (BRS §3(g))`);
  return `${code},${Math.floor(num)}`;
}

// ─── Validators for the critical employer ref numbers ─────────────────────────

/** BRS: code 2020 must be 10 numeric chars. Starts with 7 if registered for PAYE; otherwise 0/1/2/3/9. */
export function isValidPayeRef(value: string): boolean {
  return /^[01237][0-9]{9}$/.test(value);
}

/** BRS: code 2022 — L + 9 digits. */
export function isValidSdlRef(value: string): boolean {
  return /^L[0-9]{9}$/.test(value);
}

/** BRS: code 2024 — U + 9 digits. */
export function isValidUifRef(value: string): boolean {
  return /^U[0-9]{9}$/.test(value);
}

/** BRS: SARS income tax number — 10 numeric, first digit 0/1/2/3/9. */
export function isValidTaxNumber(value: string): boolean {
  return /^[01239][0-9]{9}$/.test(value);
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

function validateEmployee(emp: EmployeeInput): void {
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
  if (emp.grossSalary3601 <= 0) {
    throw new UsageError('At least one income code must be greater than zero — 3601 (gross salary) must be > 0 for an IRP5');
  }
}

export function buildEmployeeRecord(emp: EmployeeInput): string[] {
  validateEmployee(emp);
  const lines: (string | null)[] = [
    formatField(3010, emp.certificateNumber, 'AN'),
    formatField(3015, 'IRP5', 'AN'),
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
    formatField(3601, emp.grossSalary3601, 'N'),
    formatField(4102, emp.paye4102, 'N_CENTS'),
    formatField(4141, emp.uifEmployee4141, 'N_CENTS'),
    formatField(4142, emp.uifEmployer4142, 'N_CENTS'),
    formatField(4150, emp.sdl4150, 'N_CENTS'),
    '9999,9999',
  ];
  return lines.filter((l): l is string => l !== null);
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
