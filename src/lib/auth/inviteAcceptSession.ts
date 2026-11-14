import type { NextApiResponse } from 'next';
import type { GoTrueTokenResponse } from '@/lib/auth/gotrue';
import { setAuthCookies, setActiveCompanyCookie, setOnboardingDoneCookie } from '@/lib/auth/cookies';
import { isLiveCompanyForUser, pickInitialCompanyId } from '@/lib/auth/liveCompanies';
import { recordSignInSafely } from '@/lib/auth/recordSignIn';

/**
 * The last step of POST /api/invitations/[token]/accept: turn the verified sign-in into cookies and say where the
 * accepter lands. Returns the landing company id (null when the accepter has no live membership).
 */
export async function issueInviteSession(
  res: NextApiResponse,
  tok: GoTrueTokenResponse,
  invitedCompanyId: string,
): Promise<string | null> {
  setAuthCookies(res, {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresIn: tok.expires_in,
    persistent: false, // the acceptance page has no "Keep me signed in" box: not ticked
  });
  // The invited company is normally the right landing spot, but an invitation
  // can outlive its company (admin soft delete writes companies.status =
  // 'deleted'). Pointing the cookie at one would 403 every later request, so
  // fall back to the accepter's next live membership and, failing that, set no
  // active-company cookie at all (incident 2026-10-16).
  const landingCompanyId = (await isLiveCompanyForUser(tok.user.id, invitedCompanyId))
    ? invitedCompanyId
    : await pickInitialCompanyId(tok.user.id);
  if (landingCompanyId) { setActiveCompanyCookie(res, landingCompanyId); setOnboardingDoneCookie(res); }
  // A session was issued: that is a sign-in. Not awaited, never throws (audit 2026-11-14, item 1.1).
  void recordSignInSafely(tok.user.id, 'invite-accept');
  return landingCompanyId;
}
