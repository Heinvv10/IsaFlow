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
  'OFF_CYCLE_RUN_REFUSED', // OC payrollOffCycleRun: an off-cycle run refused before any write, naming the company's own employee numbers.
  'PAY_WEEK_LOCKED', // FQd payrollPayWeekSettings: the pay week is fixed for the tax year by an approved weekly/fortnightly run.
  'RUN_NOT_DELETABLE', // FQd payrollRunDelete: only a draft never calculated or approved is deleted; nothing written.
  'PAYROLL_RUN_NOT_FOUND', // FQd payrollRunLock: calculate of a run that is not this company's or was deleted while it waited.
  'FREQUENCY_CHANGE_STRADDLE', // FQd payrollFrequencyStraddle: a first run at a new pay frequency pays days twice or leaves days unpaid, until acknowledged.
  'FREQUENCY_STRADDLE_ACK_REFUSED', // FQd payrollFrequencyStraddleAck: nothing to acknowledge, or the run is past calculation.
  'PSP_REGISTRATION_NOT_FOR_ENTITY', // PSP-H: a PSP's entity moved and the stored registration number (3066) is not for the new one, before any write.
  'PAYROLL_MARK_PAID_REFUSED', // W7 MP payrollRunMarkPaidJudge: mark paid refused before any write (status, journal, bank file, reference or date); names the run's own figures and dates.
  'RUN_PAID', // W7 MP payrollRunReopen: a paid run is not reopened; names its payment date and the correction path.
] as const;
