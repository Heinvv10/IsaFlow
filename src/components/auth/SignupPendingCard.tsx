/**
 * Terminal state of the signup form: the account exists in GoTrue but is
 * unconfirmed and has no tenant. Nothing more happens until the emailed link is
 * opened, so this card is deliberately a dead end rather than a redirect.
 */

import Link from 'next/link';
import { MailCheck } from 'lucide-react';
import { WaitlistPageShell } from '@/components/landing/WaitlistPageShell';
import { AUTH_CARD_CLASS, AUTH_CARD_ACCENT_CLASS } from './authCardStyles';

export function SignupPendingCard({ email }: { email: string }) {
  return (
    <WaitlistPageShell>
      <div className="mx-auto w-full max-w-md lg:-mt-10">
        <div className={AUTH_CARD_CLASS}>
          <div className={AUTH_CARD_ACCENT_CLASS} />
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <MailCheck className="h-10 w-10 text-teal-600" />
            <h2 className="text-xl font-bold text-slate-900">Check your email</h2>
            <p className="text-sm text-slate-600">
              We sent a confirmation link to{' '}
              <span className="font-semibold text-slate-900">{email}</span>. Open it to
              activate your account and start your 14-day trial.
            </p>
            <p className="text-xs text-slate-500">
              The link expires in 24 hours. Check your spam folder if it hasn&apos;t
              arrived in a few minutes.
            </p>
            <Link href="/login" className="mt-2 text-sm font-semibold text-teal-700 hover:underline">
              Back to sign in
            </Link>
          </div>
        </div>
      </div>
    </WaitlistPageShell>
  );
}
