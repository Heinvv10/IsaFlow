/**
 * The free-trial length and end date, in a leaf module (no imports) so that
 * both tenant provisioning and admin company creation use the one definition
 * without the admin service pulling in provisioning's fiscal-year generator.
 */

/** Length of the free trial granted to every new tenant. */
export const TRIAL_DAYS = 30;

/** Trial expiry for a tenant created at `from`. */
export function trialEndsAt(from: Date): Date {
  return new Date(from.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}
