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

  useEffect(() => {
    if (!router.isReady || !inviteToken) return;
    void router.replace(`/accept-invite?token=${encodeURIComponent(inviteToken)}`);
  }, [router, router.isReady, inviteToken]);

  // Wait for the client-side query to hydrate so an invited user doesn't see
  // the signup form flash before the redirect fires.
  if (!router.isReady || inviteToken) return null;

  return <SignupForm />;
}
