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
 * The exception is the OTHER invitation system (userInvitationService), which
 * mails /invite/<token> and whose acceptance endpoint is withUserAuth — so its
 * invitee needs an account before they can accept, and the "Create an Account"
 * CTA is the only route to one. Without an exception that CTA bounced here,
 * here bounced to /accept-invite, and /accept-invite answers 409
 * WRONG_INVITE_FLOW for those tokens and bounced back: a closed loop with no
 * signup form in it.
 *
 * The exception is decided by the SERVER, not by the `&signup=1` query flag
 * this page used to trust (round-3 L3). The flag is attacker-settable: anyone
 * could append it to /register?invite=<a token the accept-invite flow can
 * complete> and reach a signup form that has no invitation handling at all, so
 * they registered their own tenant and the invitation stayed pending. Ask
 * GET /api/invitations/<token> instead — a 409 is that endpoint's own verdict
 * that this token belongs to the other flow, and nothing else opts out.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import { SignupForm } from '@/components/auth/SignupForm';

export default function RegisterPage() {
  const router = useRouter();

  const inviteToken =
    typeof router.query.invite === 'string' && router.query.invite.length > 0
      ? router.query.invite
      : null;

  // 'pending' until the server has ruled, so an invited user never sees the
  // signup form flash before the redirect fires.
  const [verdict, setVerdict] = useState<'pending' | 'signup' | 'redirecting'>('pending');

  useEffect(() => {
    if (!router.isReady) return;
    if (!inviteToken) {
      setVerdict('signup');
      return;
    }
    let cancelled = false;
    void (async () => {
      let wrongFlow = false;
      try {
        const res = await fetch(`/api/invitations/${encodeURIComponent(inviteToken)}`);
        wrongFlow = res.status === 409;
      } catch {
        // Unreachable endpoint: fall through to the acceptance page, which is
        // the routing this page had before the exception existed and which
        // shows the invitee a real error rather than the wrong form.
        wrongFlow = false;
      }
      if (cancelled) return;
      if (wrongFlow) {
        setVerdict('signup');
        return;
      }
      setVerdict('redirecting');
      void router.replace(`/accept-invite?token=${encodeURIComponent(inviteToken)}`);
    })();
    return () => { cancelled = true; };
  }, [router, router.isReady, inviteToken]);

  if (verdict !== 'signup') return null;

  return <SignupForm />;
}
