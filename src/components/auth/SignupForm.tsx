/**
 * SignupForm — public self-serve registration.
 *
 * Replaced the pre-launch waitlist gate on /register (plan:
 * docs/plans/2026-08-19-self-serve-signup.md). Posts to /api/auth/register,
 * which creates an UNCONFIRMED user and emails a confirmation link — no tenant
 * exists until that link is opened, so this form ends on "check your email"
 * rather than signing anyone in.
 *
 * Annual turnover is asked of direct signups only: it sets `payg_eligible` at
 * creation, which decides whether Pay-As-You-Go is offered at trial end.
 * Bureaus don't declare their own turnover, so they aren't asked.
 */

import { useState, FormEvent } from 'react';
import Link from 'next/link';
import { Building2, CircleDollarSign, Lock, Mail, UserRound } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { WaitlistPageShell } from '@/components/landing/WaitlistPageShell';
import { SignupPendingCard } from './SignupPendingCard';
import { AuthField } from './AuthField';
import {
  AUTH_CARD_CLASS,
  AUTH_CARD_ACCENT_CLASS,
  AUTH_INPUT_CLASS,
  AUTH_LABEL_CLASS,
  AUTH_ICON_CLASS,
  AUTH_PRIMARY_BUTTON_CLASS,
} from './authCardStyles';

type ApiEnvelope = { success: boolean; error?: { message?: string }; message?: string };
type SignupType = 'direct' | 'accountant';


const MIN_PASSWORD_LENGTH = 10;

export function SignupForm() {
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null);
  const [signupType, setSignupType] = useState<SignupType>('direct');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [annualTurnover, setAnnualTurnover] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const clearError = () => setError('');

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const trimmedEmail = email.trim().toLowerCase();
    const trimmedCompany = companyName.trim();

    if (trimmedCompany.length < 2) {
      setError(
        signupType === 'accountant'
          ? 'Please enter your practice name.'
          : 'Please enter your company name.',
      );
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setError('');
    setSubmitting(true);

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: trimmedEmail,
          password,
          companyName: trimmedCompany,
          signupType,
          // whole ZAR — the API converts to cents. Blank stays undeclared.
          annualTurnover:
            signupType === 'direct' && annualTurnover.trim()
              ? Number(annualTurnover.replace(/[,\s]/g, ''))
              : undefined,
        }),
      });

      const json = (await res.json()) as ApiEnvelope;

      if (!res.ok || !json.success) {
        setError(json.error?.message ?? json.message ?? 'Registration failed. Please try again.');
        return;
      }

      // No sign-in here: the account is inert until the emailed link is opened.
      setSubmittedEmail(trimmedEmail);
    } catch {
      setError('Could not reach the server. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (submittedEmail) return <SignupPendingCard email={submittedEmail} />;

  return (
    <WaitlistPageShell>
      <div className="mx-auto w-full max-w-md lg:-mt-10">
        <div className="mb-5 text-center text-white lg:text-left">
          <h2 className="text-2xl font-bold tracking-normal">Create your account</h2>
          <p className="mt-1 text-sm text-white/70">
            14 days free. No card required.
          </p>
        </div>

        <div className={AUTH_CARD_CLASS}>
          <div className={AUTH_CARD_ACCENT_CLASS} />
          <form onSubmit={(e) => void handleSubmit(e)} noValidate>
            <div className="mb-4">
              <span className={AUTH_LABEL_CLASS}>I&apos;m signing up for</span>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ['direct', 'My business'],
                    ['accountant', 'Accountant'],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => { clearError(); setSignupType(value); }}
                    disabled={submitting}
                    className={`rounded-lg border px-3 py-2.5 text-sm font-semibold transition ${
                      signupType === value
                        ? 'border-teal-500 bg-teal-500/10 text-teal-800'
                        : 'border-slate-300 bg-white/80 text-slate-600 hover:border-teal-400'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mb-4 grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="firstName" className={AUTH_LABEL_CLASS}>First name</label>
                <div className="relative">
                  <UserRound className={AUTH_ICON_CLASS} />
                  <input
                    id="firstName"
                    type="text"
                    autoComplete="given-name"
                    value={firstName}
                    onChange={(e) => { clearError(); setFirstName(e.target.value); }}
                    disabled={submitting}
                    className={AUTH_INPUT_CLASS}
                    placeholder="John"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="lastName" className={AUTH_LABEL_CLASS}>Last name</label>
                <input
                  id="lastName"
                  type="text"
                  autoComplete="family-name"
                  value={lastName}
                  onChange={(e) => { clearError(); setLastName(e.target.value); }}
                  disabled={submitting}
                  className={AUTH_INPUT_CLASS.replace('px-10', 'px-3.5')}
                  placeholder="Doe"
                />
              </div>
            </div>

            <AuthField
              id="email"
              label="Email address"
              type="email"
              autoComplete="email"
              required
              icon={Mail}
              value={email}
              onChange={(v) => { clearError(); setEmail(v); }}
              disabled={submitting}
              placeholder="you@example.com"
            />

            <AuthField
              id="companyName"
              label={signupType === 'accountant' ? 'Practice name' : 'Company name'}
              autoComplete="organization"
              required
              icon={Building2}
              value={companyName}
              onChange={(v) => { clearError(); setCompanyName(v); }}
              disabled={submitting}
              placeholder={signupType === 'accountant' ? 'Smith & Associates' : 'Acme (Pty) Ltd'}
            />

            {signupType === 'direct' && (
              <AuthField
                id="annualTurnover"
                label="Annual turnover (ZAR)"
                inputMode="numeric"
                icon={CircleDollarSign}
                value={annualTurnover}
                onChange={(v) => { clearError(); setAnnualTurnover(v); }}
                disabled={submitting}
                placeholder="750000"
                hint="Optional. Under R1 million unlocks Pay-As-You-Go pricing when your trial ends."
              />
            )}

            <AuthField
              id="password"
              label="Password"
              type="password"
              autoComplete="new-password"
              required
              icon={Lock}
              value={password}
              onChange={(v) => { clearError(); setPassword(v); }}
              disabled={submitting}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
            />

            <AuthField
              id="confirmPassword"
              label="Confirm password"
              type="password"
              autoComplete="new-password"
              required
              icon={Lock}
              value={confirmPassword}
              onChange={(v) => { clearError(); setConfirmPassword(v); }}
              disabled={submitting}
              placeholder="Re-enter your password"
            />

            {error && (
              <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className={AUTH_PRIMARY_BUTTON_CLASS}
            >
              {submitting ? <LoadingSpinner size="sm" /> : 'Create account'}
            </button>

            <p className="mt-4 text-center text-xs text-slate-500">
              Already have an account?{' '}
              <Link href="/login" className="font-semibold text-teal-700 hover:underline">
                Sign in
              </Link>
            </p>
          </form>
        </div>
      </div>
    </WaitlistPageShell>
  );
}
