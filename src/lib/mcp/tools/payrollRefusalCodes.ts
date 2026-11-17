/**
 * Wave 6 payroll refusal codes an MCP tool may show an agent verbatim (spread into `refusalCodes.ts`, which is over
 * the 300-line cap; spec rule 19). Append-only: each later wave-6 PR adds one line for its own code.
 */
export const PAYROLL_REFUSAL_CODES = [
  // payrollRunKindGuard: a run kind, frequency, tax status, assignment or garnishee this release cannot handle. Names
  // only the run's kind and the company's own employee numbers; raised before any write.
  'RUN_KIND_UNSUPPORTED',
  'PAYSLIP_EMAIL_REFUSED', // PE payslipDeliveryRefusal: a payslip email refused before anything is sent or written.
] as const;
