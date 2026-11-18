/**
 * Group membership is changed with the member company as the ACTIVE company (row security, migration 999r, and the
 * company-groups route answer 403 otherwise). The screen says so before the user clicks into the refusal.
 */

/** True when `companyId` is the active company (ids compare whatever their case). */
export function isActiveCompany(companyId: string, activeCompanyId: string | null): boolean {
  return !!activeCompanyId && companyId.toLowerCase() === activeCompanyId.toLowerCase();
}

/**
 * The name of a disabled action on a member row: the action and the reason ("Edit - switch to X to change this"), so
 * two disabled buttons on one row are not announced alike. With no active company known the reason is that, not a switch.
 */
export const disabledAction = (action: string, companyName: string, activeKnown: boolean): string =>
  activeKnown ? `${action} - switch to ${companyName} to change this` : `${action} ${companyName} - your active company has not loaded`;

/** The hint under a member row's name. */
export const rowHint = (companyName: string, activeKnown: boolean): string =>
  activeKnown ? `Switch to ${companyName} to change this` : 'Your active company has not loaded: reload to change this';

export const switchToAdd = (companyName: string, activeKnown: boolean): string =>
  activeKnown ? `${companyName} (switch to this company to add it)` : companyName;
