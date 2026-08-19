/**
 * SignupForm — public self-serve registration.
 *
 * Replaced the pre-launch waitlist gate on /register (plan:
 * docs/plans/2026-08-19-self-serve-signup.md). Posts to /api/auth/register,
 * which provisions the tenant on a 14-day trial and sets auth cookies, so we
 * land straight on /onboarding without a second sign-in round-trip.
 *
 * Annual turnover is asked of direct signups only: it sets `payg_eligible` at
 * creation, which decides whether Pay-As-You-Go is offered at trial end.
 * Bureaus don't declare their own turnover, so they aren't asked.
 */

import { useState, FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Building2, CircleDollarSign, Lock, Mail, UserRound } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { WaitlistPageShell } from '@/components/landing/WaitlistPageShell';

type ApiEnvelope = { success: boolean; error?: { message?: string }; message?: string };
type SignupType = 'direct' | 'accountant';

const INPUT_CLASS =
  'w-full rounded-lg border border-slate-300 !bg-white/95 px-10 py-3 text-sm !text-slate-950 ' +
  'shadow-sm shadow-slate-950/5 placeholder-slate-400 transition focus:border-transparent ' +
  'focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50';
const LABEL_CLASS = 'mb-1.5 block text-xs font-semibold text-slate-700';
const ICON_CLASS =
  'pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400';

const MIN_PASSWORD_LENGTH = 10;

export function SignupForm() {
  const router = useRouter();
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

      // register sets the auth cookies, so we're already signed in.
      await router.push('/onboarding');
    } catch {
      setError('Could not reach the server. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <WaitlistPageShell>
      <div className="mx-auto w-full max-w-md lg:-mt-10">
        <div className="mb-5 text-center text-white lg:text-left">
          <h2 className="text-2xl font-bold tracking-normal">Create your account</h2>
          <p className="mt-1 text-sm text-white/70">
            14 days free. No card required.
          </p>
        </div>

        <div className="relative overflow-hidden rounded-2xl border border-white/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(248,250,252,0.88))] p-6 shadow-[0_24px_70px_rgba(2,8,23,0.34)] backdrop-blur-2xl sm:p-8">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-teal-300/80 via-teal-500 to-cyan-300/70" />
          <form onSubmit={(e) => void handleSubmit(e)} noValidate>
            <div className="mb-4">
              <span className={LABEL_CLASS}>I&apos;m signing up for</span>
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
                <label htmlFor="firstName" className={LABEL_CLASS}>First name</label>
                <div className="relative">
                  <UserRound className={ICON_CLASS} />
                  <input
                    id="firstName"
                    type="text"
                    autoComplete="given-name"
                    value={firstName}
                    onChange={(e) => { clearError(); setFirstName(e.target.value); }}
                    disabled={submitting}
                    className={INPUT_CLASS}
                    placeholder="John"
                  />
                </div>
              </div>
              <div>
                <label htmlFor="lastName" className={LABEL_CLASS}>Last name</label>
                <input
                  id="lastName"
                  type="text"
                  autoComplete="family-name"
                  value={lastName}
                  onChange={(e) => { clearError(); setLastName(e.target.value); }}
                  disabled={submitting}
                  className={INPUT_CLASS.replace('px-10', 'px-3.5')}
                  placeholder="Doe"
                />
              </div>
            </div>

            <div className="mb-4">
              <label htmlFor="email" className={LABEL_CLASS}>
                Email address <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Mail className={ICON_CLASS} />
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => { clearError(); setEmail(e.target.value); }}
                  disabled={submitting}
                  className={INPUT_CLASS}
                  placeholder="you@example.com"
                />
              </div>
            </div>

            <div className="mb-4">
              <label htmlFor="companyName" className={LABEL_CLASS}>
                {signupType === 'accountant' ? 'Practice name' : 'Company name'}{' '}
                <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Building2 className={ICON_CLASS} />
                <input
                  id="companyName"
                  type="text"
                  autoComplete="organization"
                  required
                  value={companyName}
                  onChange={(e) => { clearError(); setCompanyName(e.target.value); }}
                  disabled={submitting}
                  className={INPUT_CLASS}
                  placeholder={signupType === 'accountant' ? 'Smith & Associates' : 'Acme (Pty) Ltd'}
                />
              </div>
            </div>

            {signupType === 'direct' && (
              <div className="mb-4">
                <label htmlFor="annualTurnover" className={LABEL_CLASS}>
                  Annual turnover (ZAR)
                </label>
                <div className="relative">
                  <CircleDollarSign className={ICON_CLASS} />
                  <input
                    id="annualTurnover"
                    type="text"
                    inputMode="numeric"
                    value={annualTurnover}
                    onChange={(e) => { clearError(); setAnnualTurnover(e.target.value); }}
                    disabled={submitting}
                    className={INPUT_CLASS}
                    placeholder="750000"
                  />
                </div>
                <p className="mt-1.5 text-xs leading-5 text-slate-500">
                  Optional. Under R1 million unlocks Pay-As-You-Go pricing when your trial ends.
                </p>
              </div>
            )}

            <div className="mb-4">
              <label htmlFor="password" className={LABEL_CLASS}>
                Password <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Lock className={ICON_CLASS} />
                <input
                  id="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={password}
                  onChange={(e) => { clearError(); setPassword(e.target.value); }}
                  disabled={submitting}
                  className={INPUT_CLASS}
                  placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                />
              </div>
            </div>

            <div className="mb-5">
              <label htmlFor="confirmPassword" className={LABEL_CLASS}>
                Confirm password <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Lock className={ICON_CLASS} />
                <input
                  id="confirmPassword"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirmPassword}
                  onChange={(e) => { clearError(); setConfirmPassword(e.target.value); }}
                  disabled={submitting}
                  className={INPUT_CLASS}
                  placeholder="Re-enter your password"
                />
              </div>
            </div>

            {error && (
              <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-teal-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-teal-600/25 transition hover:bg-teal-700 disabled:opacity-60"
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
