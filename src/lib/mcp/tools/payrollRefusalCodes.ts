/**
 * Wave 6 payroll refusal codes an MCP tool may show an agent verbatim (spread into `refusalCodes.ts`, which is over
 * the 300-line cap; spec rule 19). Append-only: each later wave-6 PR adds one line for its own code.
 */
export const PAYROLL_REFUSAL_CODES = [
  // payrollRunKindGuard: a run kind, frequency, tax status, assignment or garnishee this release cannot handle. Names
  // only the run's kind and the company's own employee numbers; raised before any write.
  'RUN_KIND_UNSUPPORTED',
  'PAYROLL_BANK_FILE_REFUSED', // BF payrollBankFileStatus: a bank-file write refused before any write, naming the run's own employee numbers.
  'PAYSLIP_EMAIL_REFUSED', // PE payslipDeliveryRefusal: a payslip email refused before anything is sent or written.
  'PAY_FREQUENCY_REFUSED', // FQc payrollFrequencyGuard: terms a weekly or fortnightly run cannot cost, its EMP201 month, a mid-year frequency change; names the company's own employee numbers, before any write.
  'PAY_PERIOD_OVERLAP', // FQc payrollFrequencyGuard: a weekly or fortnightly run's dates overlap another regular run of its frequency (review #1575 G6).
  'EMPLOYEE_PORTAL_REFUSED', // SS employeePortalRefusal: a portal invite, revoke or sign-in refused before any write or send.
  'PAY_WEEK_LOCKED', // FQd payrollPayWeekSettings: the pay week is fixed for the tax year by an approved weekly/fortnightly run.
  'FREQUENCY_CHANGE_MID_YEAR', // FQd payrollEmployeePayFrequency: the employee is on an approved run this tax year.
  'FREQUENCY_UNSUPPORTED_FOR_EMPLOYEE', // FQd: weekly/fortnightly with a fringe benefit, loan or regular-pay directive (§0a.11).
  'RUN_NOT_DELETABLE', // FQd payrollRunDelete: only a draft never calculated or approved is deleted; nothing written.
] as const;
