import type { EtiResult } from './payrollTypesEti';
import type { PayeYearToDate } from './payrollTypesYtd';
export type EmploymentType = 'permanent' | 'contract' | 'casual' | 'director';

/** What the engine reads (TS-b): employment_type is display and HR only. Migration 967. */
export type TaxStatus = 'employee' | 'director' | 'independent_contractor';
export type PayBasis = 'monthly' | 'hourly' | 'daily';
/** The unit of a run's quantity on a component row (migration 967). */
export type QuantityUnit = 'hour' | 'day';

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
  /** The employer holds the employee's s18A receipt: donations (4030) may reduce PAYE and SDL (migration 959). */
  s18aReceiptHeld: boolean;
  costCentreId?: string | null;
  payScaleId?: string | null;
  occupationalLevelId?: string | null;
  /** How net pay reaches them (mig 455): cash is paid from the cash register, not by EFT. */
  paymentMethod?: 'eft' | 'cash';
  /** Tax status (mig 967): nothing reads it in the calculator yet. */
  taxStatus: TaxStatus;
  payBasis: PayBasis;
  hoursPerWeek?: number | null;
  hoursPerDay?: number | null;
  hourlyRate?: number | null;
  dailyRate?: number | null;
  /** BCEA s33(1)(b) occupation, at most 100 characters. */
  occupation?: string | null;
}

export interface PayrollComponent {
  id: string;
  name: string;
  sarsSourceCode: string;
  componentType: 'earning' | 'deduction' | 'employer_contribution';
  isTaxable: boolean;
  isUifApplicable: boolean;
  isSdlApplicable: boolean;
  /**
   * A retirement fund contribution (4001/4003/4006 deduction) the employee pays the fund directly: counted for
   * the s11F deduction and the certificate, never deducted from pay (migration 948, PAYE 4c). Absent = false.
   */
  paidOutsidePayroll?: boolean;
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
  /** Taxable remuneration reported on the payslip but not paid to the employee in cash. */
  isNonCash?: boolean;
  /** The share of a taxable periodic earning that is remuneration for PAYE (0.8 or 0.2; fringeBenefits.ts). Absent = all of it. */
  payeInclusionRate?: number;
  /** A 3810 earning under the explicit gross-up opt-in: paid as cash, its fees are the 4005 deduction's (employerContributions.ts). */
  medicalGrossUp?: boolean;
  /** Set on a lump-sum (39xx) component paid under a directive; see payrollCalculator. */
  directive?: DirectiveFigures;
  /** The assignment's is_recurring, when read from payroll_employee_components (the termination base takes recurring rows only). */
  isRecurring?: boolean;
  /** The payroll_employee_components row it was read from (the pro-rata guard asks which rows the reader paid). */
  assignmentId?: string;
  /** Hours or days this row pays (HD, migration 967): amount = quantity x the rate at entry. Absent on a plain amount. */
  quantity?: number | null;
  quantityUnit?: QuantityUnit | null;
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
  /** Medical scheme fees paid through payroll for the year (4005), for the 65+ additional credit; absent = none. */
  annualMedicalSchemeFees?: number;
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

export type { EtiInput, EtiMissingInput, EtiResult } from './payrollTypesEti';

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationResult {
  code: string;
  severity: ValidationSeverity;
  message: string;
  field?: string;
  deepLink?: string;
  /** PAYE_LATER_PERIODS_APPROVED only: the later months it names, YYYY-MM. The approval gate matches on this, not the message. */
  periods?: string[];
  /** DEDUCTIONS_EXCEED_PAY only: net pay before the floor at nil, negative. */
  rawNet?: number;
  /** LOAN_DEDUCTION_MISSING only: the loan numbers whose instalment was not taken. */
  loans?: string[];
  /** LOAN_DEDUCTION_MISSING only: the components missing, 'LOAN' and, when also missing, '3801'. */
  missing?: string[];
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
  /**
   * HD: the hours or days behind `amount` (0 is an entered nil; the keys are omitted when none was recorded), and `rate` = amount / quantity,
   * the EFFECTIVE rate it was paid at, to four decimals: the employee's rate at entry, not looked up again. Omitted at quantity 0.
   */
  quantity?: number;
  quantityUnit?: QuantityUnit;
  rate?: number;
  /**
   * The item counted toward this line's SDL-applicable remuneration, as costed: an earning flagged
   * is_sdl_applicable (payrollCalculator's sdlLeviable). Absent on a line costed before it existed;
   * payrollYearToDate then reads today's catalogue instead.
   */
  isSdlApplicable?: boolean;
  /** True when the earning is taxable remuneration but is not paid in cash. */
  isNonCash?: true;
  /** As on EmployeeComponent: the PAYE inclusion the line was costed with, kept so a reader need not re-derive it. */
  payeInclusionRate?: number;
  /** What the calculator took as remuneration for PAYE from this item (amount x rate, to the cent): exact for the certificate's 4582. */
  payeIncludedAmount?: number;
  directive?: DirectiveFigures;
  /** Set on an employee retirement fund contribution (4001/4003/4006 deduction; PAYE 4c, migration 948). */
  retirementContribution?: true;
  /** Set on a contribution paid outside payroll: not deducted from this line's net pay. */
  paidOutsidePayroll?: true;
}

export type { PayeYearToDate } from './payrollTypesYtd';


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
  /** Every earning, non-cash benefits included (grossPay is cash only): the ETI base and the employer SDL threshold basis. */
  remuneration: number;
  /** Regular plus annual-payment remuneration, before the retirement fund deduction (`retirementDeduction`). Lump sums are not in it. */
  taxableIncome: number;
  /** Periodic and annual-payment remuneration BEFORE the retirement fund deduction (stored on the line for the next period's year-to-date). */
  periodicTaxable: number;
  annualTaxable: number;
  /** Taxable table remuneration before taxable deductions; not stored, used by the run's later-period warning. */
  periodicRemuneration: number;
  annualPaymentRemuneration: number;
  /** The regular calculation's figures, except `monthlyPaye`, which is the line's whole PAYE (payeSplit summed). */
  paye: PayeResult;
  payeSplit: PayeSplit;
  /** The medical scheme fees tax credit this line's PAYE took into account (payeCumulative; e@syFile 4116). */
  medicalCredit: number;
  /** The 65+ additional medical expenses tax credit this line's PAYE took into account (payeCumulative; e@syFile 4120). */
  additionalMedicalCredit: number;
  /** Medical scheme fees deducted on this line: deductions coded 4005 (e@syFile 4005). */
  medicalSchemeFees: number;
  /** Employee retirement fund contributions on this line: deductions coded 4001/4003/4006 (PAYE 4c). */
  retirementContributions: number;
  /** The retirement fund deduction this line's PAYE took into account (payeCumulative; section 11F). */
  retirementDeduction: number;
  uif: UifResult;
  sdl: number;
  /**
   * This line's SDL leviable amount, cumulative over the tax year's liable months (sdlLeviableCumulative): the rise
   * in max(0, SDL-applicable pay to date - the s11F retirement and s18A donation deductions allowed to date), capped at that pay,
   * never below nil (SDL Act s3(3)) and rounded to the cent.
   */
  sdlLeviable: number;
  /** This line's SDL-applicable earnings (earnings flagged is_sdl_applicable), before any deduction, to the cent. */
  sdlApplicable: number;
  /** s18aDonation: 4030 counted toward the limit, this line's base, and the deduction it allowed (migration 959). */
  donationReceipted: number;
  donationBase: number;
  donationDeduction: number;
  eti: EtiResult;
  netPay: number;
  componentBreakdown: ComponentBreakdownItem[];
  validationResults: ValidationResult[];
  /** Hours worked on this run (HD): hours, or days x hours per day. Null when not recorded or not determinable, never 0. */
  hours: number | null;
}
