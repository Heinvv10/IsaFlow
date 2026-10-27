/**
 * /register — public self-serve signup.
 *
 * Open registration since 2026-08-19 (docs/plans/2026-08-19-self-serve-signup.md).
 * Anyone can create a tenant here; it lands on a 14-day trial.
 *
 * `?invite=[token]` never shows this form. An invitation is to join a company
 * that already exists, and this form creates a new one, so an invitee who
 * submitted it ended up in their own trial tenant with the invitation still
 * pending. Every invitation, from either invitation system, is accepted at
 * /accept-invite, where the invitee sets a password (or enters their existing
 * one) and joins the inviting company.
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

  // Nothing until the query is known, so an invitee never sees the signup form
  // flash before the redirect fires.
  if (!router.isReady || inviteToken) return null;

  return <SignupForm />;
}
