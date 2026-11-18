/**
 * Group membership is changed with the member company as the ACTIVE company (row security, migration 999r, and the
 * company-groups route answer 403 otherwise). The screen says so before the user clicks into the refusal.
 */

/** True when `companyId` is the active company (ids compare whatever their case). */
export function isActiveCompany(companyId: string, activeCompanyId: string | null): boolean {
  return !!activeCompanyId && companyId.toLowerCase() === activeCompanyId.toLowerCase();
}

/** The hint on a member row or picker entry that is not the active company. */
export const switchToChange = (companyName: string): string => `Switch to ${companyName} to change this`;
export const switchToAdd = (companyName: string): string => `${companyName} (switch to this company to add it)`;
