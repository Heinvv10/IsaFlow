/**
 * Which company a consent grant will be pinned to — ZERO runtime imports
 * (client-bundle safe, same discipline as consentScopes.ts).
 *
 * The grant is pinned to ONE company for the life of the token: bearerPipeline
 * pushes it into the RLS GUC per request and never re-reads a cookie. Nothing
 * downstream can widen or move it. So the consent screen must state which
 * company it is handing over, and let a multi-company user choose — otherwise
 * the only signal is whichever company happened to be active in the browser,
 * which is how a grant silently lands on the wrong tenant.
 *
 * The choice list is always derived server-side from real memberships;
 * consent.ts re-checks membership on the submitted companyId regardless
 * (defence in depth — this resolver is UX, not the authorisation boundary).
 */

export interface ConsentCompany {
  id: string;
  name: string;
}

export interface ConsentCompanyMembership {
  companyId: string;
  companyName: string;
  isDefault: boolean;
}

export interface ConsentCompanyChoice {
  companies: ConsentCompany[];
  selectedCompanyId: string;
}

/**
 * Build the picker's options and its default selection.
 *
 * Preference order for the default: the active-company cookie (what the user
 * is looking at in the app), then their default membership, then the first.
 * An active-company value the user is not a member of is ignored rather than
 * trusted — a stale or tampered cookie must never preselect a tenant.
 *
 * Returns null when the user has no company at all; the caller must refuse the
 * consent screen rather than render a picker with nothing to pick.
 */
export function resolveConsentCompany(
  memberships: readonly ConsentCompanyMembership[],
  activeCompanyId: string | undefined,
): ConsentCompanyChoice | null {
  if (memberships.length === 0) return null;

  const companies = memberships.map((m) => ({ id: m.companyId, name: m.companyName }));

  const active = activeCompanyId
    ? memberships.find((m) => m.companyId === activeCompanyId)
    : undefined;
  // memberships is non-empty (guarded above), so [0] is always present —
  // spelled out rather than asserted so noUncheckedIndexedAccess stays honest.
  const first = memberships[0] as ConsentCompanyMembership;
  const fallback = memberships.find((m) => m.isDefault) ?? first;

  return { companies, selectedCompanyId: (active ?? fallback).companyId };
}
