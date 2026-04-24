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

export interface EmployeeComponent {
  component: PayrollComponent;
  amount: number;
}

export interface PayrollPeriod {
  month: number;
  year: number;
}

export interface PayeInput {
  annualTaxableIncome: number;
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

export interface EtiResult {
  isEligible: boolean;
  ineligibilityReason?: string;
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
}

export interface PayrollLineInput {
  employee: PayrollEmployee;
  components: EmployeeComponent[];
  period: PayrollPeriod;
  taxYear: number;
  annualPayrollEstimate: number;
  priorPeriodCumulativePaye?: number;
}

export interface ComponentBreakdownItem {
  componentId: string;
  componentName: string;
  sarsSourceCode: string;
  amount: number;
  isTaxable: boolean;
  isUifApplicable: boolean;
}

export interface PayrollLineResult {
  employeeId: string;
  grossPay: number;
  taxableIncome: number;
  paye: PayeResult;
  uif: UifResult;
  sdl: number;
  eti: EtiResult;
  netPay: number;
  componentBreakdown: ComponentBreakdownItem[];
  validationResults: ValidationResult[];
}
