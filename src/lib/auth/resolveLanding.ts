/**
 * Pure post-login landing decision. No I/O — the endpoint that calls this
 * supplies the two booleans (derived from getUserCompanies / listBureausForUser).
 *
 * - No companies        → /onboarding
 * - Bureau member        → /bureau (firm users land on the cross-client cockpit)
 * - Direct client        → /home (companies but no bureau)
 */
export interface LandingInput {
  hasCompanies: boolean;
  isBureauMember: boolean;
}

export function resolveDefaultLanding(input: LandingInput): string {
  if (!input.hasCompanies) return '/onboarding';
  if (input.isBureauMember) return '/bureau';
  return '/home';
}
