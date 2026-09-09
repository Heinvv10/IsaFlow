/**
 * /register — public self-serve signup.
 *
 * Open registration since 2026-08-19 (docs/plans/2026-08-19-self-serve-signup.md).
 * Anyone can create a tenant here; it lands on a 14-day trial.
 *
 * `?invite=[token]` is legacy: invitation emails have always pointed at
 * /accept-invite (pages/api/invitations/index.ts), and the old in-page invite
 * form posted to /api/auth/register, which would have created a SECOND company
 * instead of joining the inviting one. Redirect those links to the real
 * acceptance page rather than re-implementing it.
 *
 * `&signup=1` opts out of that redirect. The OTHER invitation system
 * (userInvitationService) mails /invite/<token>, whose acceptance endpoint is
 * withUserAuth — so its invitee needs an account before they can accept, and
 * its "Create an Account" CTA is the only route to one. Without the opt-out
 * that CTA bounced here, here bounced to /accept-invite, and /accept-invite
 * answers 409 WRONG_INVITE_FLOW for those tokens and bounced back: a closed
 * loop with no signup form in it. Only that page and /login?invite= set the
 * flag, and both learn the token is theirs from GET /api/invite/<token>.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/router';
import { SignupForm } from '@/components/auth/SignupForm';

export default function RegisterPage() {
  const router = useRouter();

  const inviteToken =
    typeof router.query.invite === 'string' && router.query.invite.length > 0
      ? router.query.invite
      : null;

  const skipAcceptRedirect = router.query.signup === '1';

  useEffect(() => {
    if (!router.isReady || !inviteToken || skipAcceptRedirect) return;
    void router.replace(`/accept-invite?token=${encodeURIComponent(inviteToken)}`);
  }, [router, router.isReady, inviteToken, skipAcceptRedirect]);

  // Wait for the client-side query to hydrate so an invited user doesn't see
  // the signup form flash before the redirect fires.
  if (!router.isReady) return null;
  if (inviteToken && !skipAcceptRedirect) return null;

  return <SignupForm />;
}
