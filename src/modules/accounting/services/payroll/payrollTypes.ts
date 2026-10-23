export type EmploymentType = 'permanent' | 'contract' | 'casual' | 'director';

export interface PayrollEmployee {
  id: string;
  companyId: string;
  employeeNumber: string;
  firstName: string;
  lastName: string;
  idNumber?: string;
  taxNumber?: string;
  employmentType: EmploymentType;
  startDate: Date;
  endDate?: Date;
  dateOfBirth?: Date;
  uifExcluded: boolean;
  medicalAidMainMember: boolean;
  medicalAidDependantsCount: number;
  costCentreId?: string | null;
  payScaleId?: string | null;
  occupationalLevelId?: string | null;
}

export interface PayrollComponent {
  id: string;
  name: string;
  sarsSourceCode: string;
  componentType: 'earning' | 'deduction' | 'employer_contribution';
  isTaxable: boolean;
  isUifApplicable: boolean;
  isSdlApplicable: boolean;
}

/** The SARS tax directive a lump-sum component (39xx) is paid under, and the PAYE it prescribes. */
export interface DirectiveFigures {
  id: string;
  number: string | null;
  paye: number;
}

export interface EmployeeComponent {
  component: PayrollComponent;
  amount: number;
  /** Set on a lump-sum (39xx) component paid under a directive; see payrollCalculator. */
  directive?: DirectiveFigures;
}

export interface PayrollPeriod {
  month: number;
  year: number;
}

export interface PayeInput {
  annualTaxableIncome: number;
  /** Age on the last day of the tax year (28/29 Feb), which decides the age rebates. */
  ageAtPeriodEnd: number;
  monthlyMedicalBeneficiaries: number;
  taxYear: number;
}

export interface PayeResult {
  annualTax: number;
  monthlyPaye: number;
  effectiveRate: number;
  rebatesApplied: number;
  medicalCreditsApplied: number;
}

export interface UifResult {
  employeeContribution: number;
  employerContribution: number;
  isCapped: boolean;
}

export interface EtiInput {
  dateOfBirth: Date;
  employmentStartDate: Date;
  periodDate: Date;
  monthlyRemuneration: number;
  isUifExcluded: boolean;
}

/** An employee field the ETI engine needs and may not have. */
export type EtiMissingInput = 'date_of_birth' | 'employment_start_date';

export interface EtiResult {
  /**
   * True only when the engine DETERMINED the employee qualifies. False covers
   * both "determined ineligible" and "could not determine" — read
   * `isDeterminable` to tell those apart before acting on it.
   */
  isEligible: boolean;
  /**
   * Why the employee was determined ineligible. Undefined when eligible, and
   * ALSO undefined when `isDeterminable` is false — stating a reason there would
   * assert a determination that was never made.
   */
  ineligibilityReason?: string;
  /**
   * False when the engine lacked an input it needs, so eligibility was never
   * assessed. Distinguishes "this employee does not qualify" (a finding) from
   * "we do not know" (a data gap that silently forfeits a tax credit).
   */
  isDeterminable: boolean;
  /** The absent inputs. Always empty when `isDeterminable` is true. */
  missingInputs: EtiMissingInput[];
  monthsEmployed: number;
  employmentYear: 1 | 2 | null;
  monthlyEti: number;
}

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationResult {
  code: string;
  severity: ValidationSeverity;
  message: string;
  field?: string;
  deepLink?: string;
  /** PAYE_LATER_PERIODS_APPROVED only: the later months it names, YYYY-MM. The approval gate matches on this, not the message. */
  periods?: string[];
}

export interface PayrollLineInput {
  employee: PayrollEmployee;
  components: EmployeeComponent[];
  period: PayrollPeriod;
  taxYear: number;
  /**
   * The employer's estimated annual remuneration, used only to decide SDL
   * leviability. Pass `'defer'` when costing a whole run: the R500 000
   * exemption is a property of the employer's total remuneration over twelve
   * months, which is not known until every line has been costed, so the run
   * service applies the threshold itself in a second pass over `sdlLeviable`.
   * Deferring returns `sdl` as 0, and the caller MUST then set it — the value
   * is spelled out rather than omitted so that forgetting is a type error.
   */
  annualPayrollEstimate: number | 'defer';
  /**
   * The employee's earlier periods of this tax year (payrollYearToDate), for
   * the cumulative PAYE (payeCumulative). Absent = none: the first period,
   * which gives the x12 result.
   */
  ytd?: PayeYearToDate;
  /**
   * True for a leaver paid after leaving (the severance-only line of a later
   * run): no hours employed in the period, so no ETI (see payrollCalculator).
   */
  notEmployedInPeriod?: boolean;
}

export interface ComponentBreakdownItem {
  componentId: string;
  componentName: string;
  sarsSourceCode: string;
  amount: number;
  isTaxable: boolean;
  isUifApplicable: boolean;
  directive?: DirectiveFigures;
}

/** An employee's earlier periods of the tax year, as the cumulative PAYE needs them. */
export interface PayeYearToDate {
  /** Periods with periodic pay (the n of the cumulative formula, before this one). */
  periods: number;
  /** Periodic taxable remuneration, after taxable deductions. */
  periodicTaxable: number;
  /** Annual payments (3605) taxed by the annual-payment method. */
  annualPayments: number;
  /** PAYE deducted by the tables (regular + annual payments), directive PAYE excluded. */
  tablePaye: number;
}

/** How a line's PAYE is made up (audit 2026-10-18 P3). */
export interface PayeSplit {
  /** Periodic PAYE on the regular remuneration, cumulative to date (payeCumulative). */
  regular: number;
  /** PAYE on annual payments (3605), by the SARS annual-payment method. */
  annualPayment: number;
  /** PAYE prescribed by the directives of the line's lump sums (39xx). */
  directive: number;
}

export interface PayrollLineResult {
  employeeId: string;
  grossPay: number;
  /** Regular plus annual-payment remuneration: what the tax tables were applied to. Lump sums are not in it. */
  taxableIncome: number;
  /** taxableIncome split: periodic and annual payments (stored on the line for the next period's year-to-date). */
  periodicTaxable: number;
  annualTaxable: number;
  /** The regular calculation's figures, except `monthlyPaye`, which is the line's whole PAYE (payeSplit summed). */
  paye: PayeResult;
  payeSplit: PayeSplit;
  uif: UifResult;
  sdl: number;
  /** Remuneration this line contributes to the SDL leviable amount. */
  sdlLeviable: number;
  eti: EtiResult;
  netPay: number;
  componentBreakdown: ComponentBreakdownItem[];
  validationResults: ValidationResult[];
}
