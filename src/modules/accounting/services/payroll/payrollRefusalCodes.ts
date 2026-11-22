/**
 * The named refusal codes an off-cycle refusal carries (OffCycleRunRefusedError.refusal), so a route's
 * details.refusal and the MCP tools' envelope name one value each (review L2 of e9f437f366).
 */
export const PAYROLL_REFUSAL = {
  /** A termination run's leaver has no termination reason (at create and at calculate). */
  TERMINATION_REASON_MISSING: 'TERMINATION_REASON_MISSING',
  /** A bonus employee has no line on the month's final regular run (at calculate). */
  REGULAR_LINE_MISSING: 'REGULAR_LINE_MISSING',
  /** A bonus amount edit's expectedAmount is not the stored amount: someone changed it since it was read. */
  AMOUNT_CHANGED: 'AMOUNT_CHANGED',
} as const;

export type PayrollRefusalCode = typeof PAYROLL_REFUSAL[keyof typeof PAYROLL_REFUSAL];
