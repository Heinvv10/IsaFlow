/**
 * Plans that exist for the platform's own bookkeeping and are never something
 * an admin converts a trial TO: `trial` is the free trial itself, `payg` the R0
 * pay-as-you-go wallet plan. Shared by the Convert dialog (which does not offer
 * them) and the convert service (which refuses them). Pure: safe in the browser.
 */
export const INTERNAL_PLAN_CODES: readonly string[] = ['trial', 'payg'];

export function isConvertiblePlanCode(code: string): boolean {
  return !INTERNAL_PLAN_CODES.includes(code);
}
