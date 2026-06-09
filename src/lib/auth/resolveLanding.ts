/**
 * Pure post-login landing decision. No I/O — the endpoint that calls this
 * supplies the two booleans (derived from getUserCompanies / listBureausForUser).
 *
 * - No companies        → /onboarding
 * - Bureau member        → /accounting (firm users; unchanged default)
 * - Direct client        → /home (companies but no bureau)
 */
export interface LandingInput {
  hasCompanies: boolean;
  isBureauMember: boolean;
}

export function resolveDefaultLanding(input: LandingInput): string {
  if (!input.hasCompanies) return '/onboarding';
  if (input.isBureauMember) return '/accounting';
  return '/home';
}
