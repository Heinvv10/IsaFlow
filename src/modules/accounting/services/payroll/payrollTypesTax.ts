/**
 * The PAYE and UIF calculators' input and result types (moved out of payrollTypes.ts, unchanged, for the 300-line cap).
 * payrollTypes re-exports them, so every importer is as before.
 */
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
