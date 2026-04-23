/**
 * /register — routes between two flows:
 *
 *   1. `?invite=[token]` present → real account registration for the invitee
 *      (InviteRegisterForm). This is the only way to create an account while
 *      we're pre-launch.
 *   2. No invite token → waitlist lead-capture (WaitlistForm). We're marketing
 *      but not yet taking paying customers, so public "Sign up" / "Start free
 *      trial" CTAs land here and collect interest for launch.
 */

import { useRouter } from 'next/router';
import { WaitlistForm } from '@/components/landing/WaitlistForm';
import { InviteRegisterForm } from '@/components/auth/InviteRegisterForm';

export default function RegisterPage() {
  const router = useRouter();

  // Wait for the client-side query to hydrate so an invite-based signup
  // doesn't briefly flash the waitlist form before the real form appears.
  if (!router.isReady) return null;

  const inviteToken =
    typeof router.query.invite === 'string' && router.query.invite.length > 0
      ? router.query.invite
      : null;

  if (inviteToken) {
    return <InviteRegisterForm inviteToken={inviteToken} />;
  }

  return <WaitlistForm />;
}
