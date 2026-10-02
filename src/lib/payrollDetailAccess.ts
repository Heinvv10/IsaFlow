/**
 * What a payroll page says when the server refuses per-employee detail (403,
 * withPayrollDetailAccess): one message everywhere, so no page shows a generic
 * load failure or a blank table to a viewer. No imports — safe in any bundle.
 */
export const NO_PAYROLL_DETAIL_ACCESS = "You don't have access to payroll detail.";

/** The text for a failed payroll-detail read: the access message on 403, else `fallback`. */
export function payrollLoadMessage(status: number, fallback: string): string {
  return status === 403 ? NO_PAYROLL_DETAIL_ACCESS : fallback;
}
