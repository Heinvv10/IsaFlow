/** An employee's earlier periods of the tax year, as the cumulative PAYE needs them. */
export interface PayeYearToDate {
  /** Periods with periodic pay (the n of the cumulative formula, before this one). */
  periods: number;
  /** Earlier periods with periodic pay or an annual payment, for the pro-rated s11F cap. */
  retirementCapPeriods?: number;
  /** Periodic taxable remuneration, after allowed s18A donations (PAYE 4c: before the retirement fund deduction). */
  periodicTaxable: number;
  /** Annual payments (3605) taxed by the annual-payment method, before the retirement fund deduction. */
  annualPayments: number;
  /** PAYE deducted by the tables (regular + annual payments), directive PAYE excluded. */
  tablePaye: number;
  /** Medical scheme fees tax credit recorded on those lines (payroll_run_lines.medical_credit; a line before migration 926 recorded none). */
  medicalCredit: number;
  /** Additional medical expenses tax credit recorded on those lines (additional_medical_credit; likewise). */
  additionalMedicalCredit: number;
  /** Medical scheme fees deducted on those lines (4005; a line before 926 from its breakdown, payrollMedicalRecord). */
  medicalSchemeFees: number;
  /** Retirement fund contributions on those lines (4001/4003/4006; payroll_run_lines.retirement_contributions); absent = none. */
  retirementContributions?: number;
  /** Retirement fund deduction those lines recorded (retirement_deduction; payeCumulative); absent = none. */
  retirementDeduction?: number;
  /** Donations (4030) those lines deducted from taxable income, for the s11F base; absent = none. */
  donations?: number;
  /** Lines since migration 959 (s18aDonation): 4030 counted toward the limit; absent = none. */
  donationReceipted?: number;
  /** Likewise: remuneration less retirement deduction; absent = none. */
  donationBase?: number;
  /** Likewise: the donation deduction allowed; absent = none. */
  donationDeduction?: number;
  /**
   * SDL-applicable earnings on those lines the employer was LIABLE for (payrollSdlYearToDate: an exempt line's are
   * left out); absent only when there are no earlier lines (the calculator throws otherwise).
   */
  sdlApplicable?: number;
  /** The leviable amount those liable lines carried (stored: sdl_leviable); absent only when there are no earlier lines. */
  sdlLeviable?: number;
  /** The retirement and donation deductions recorded on those liable lines; absent only when there are no earlier lines. */
  sdlRetirementDeduction?: number;
  /** The donation part of sdlRetirementDeduction, in line order and kept above nil; absent = none. */
  sdlDonationDeduction?: number;
}
