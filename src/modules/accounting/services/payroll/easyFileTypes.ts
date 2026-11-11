/**
 * The input types of the e@syFile IRP5 export (moved out of easyFileExportService.ts, unchanged, for the 300-line cap).
 * easyFileExportService re-exports them, so every importer is as before.
 */
import type { MedicalCertificateInput } from './easyFileMedicalFields';
import type { RetirementContributions } from './easyFileRetirementFields';

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
  /** An independent contractor's income, code 3616 (G21 p. 26), INSTEAD of 3601 (easyFileContractor.ts). */
  independentContractor3616?: number;
  /** Non-cash fringe benefits by income code (3801), NOT included in grossSalary3601; cents dropped. */
  fringeBenefits?: { sourceCode: string; amount: number }[];
  /** Cash allowances under their own income code (3701, the travel allowance), NOT included in grossSalary3601; cents dropped. */
  cashAllowances?: { sourceCode: string; amount: number }[];
  /** 4582: the part of 3701 + 3802 that PAYE was withheld on (payrollAllowanceFiling); absent = none of them. */
  paye4582?: number;
  /** Lump sums paid under a directive, NOT included in grossSalary3601. */
  lumpSums?: LumpSumInput[];
  /**
   * The employee's tax threshold for the year (by age). An IT3(a) with reason 02
   * ("earn less than the tax threshold") is written only when 3601 + 3605 is at
   * or under it; without it, or above it, a certificate with no tax is refused.
   */
  taxThreshold?: number;
  /** Medical scheme fees and credits (4005, 4116, 4120); absent = none reported. */
  medical?: MedicalCertificateInput;
  /** Retirement fund contributions (4001, 4003, 4006; PAYE 4c); absent = none reported. */
  retirementFund?: RetirementContributions;
  /** The payroll record's date of birth (local calendar day): 3080, which must be the ID number's date (birthDate3080). */
  dateOfBirth?: Date | null;
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
