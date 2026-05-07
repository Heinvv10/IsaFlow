/**
 * WaitlistForm - pre-launch lead capture shown on the public /register route
 * until IsaFlow is ready to take public account registrations.
 *
 * Posts to /api/waitlist and swaps to a thank-you state on success.
 */

import { useState, FormEvent } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import {
  BarChart3,
  BriefcaseBusiness,
  Building2,
  CheckCircle2,
  CircleDollarSign,
  Mail,
  Phone,
  ShieldCheck,
  UserRound,
  UsersRound,
} from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

interface ApiEnvelope {
  success: boolean;
  message?: string;
  error?: { message?: string };
}

type SignupType = 'direct' | 'accountant';

const capabilities = [
  { label: 'Financial management', icon: BriefcaseBusiness },
  { label: 'Compliance', icon: ShieldCheck },
  { label: 'Reporting', icon: BarChart3 },
  { label: 'Client work', icon: UsersRound },
];

function WaitlistPageShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative min-h-screen overflow-hidden bg-slate-950 text-slate-900"
      style={{ fontFamily: 'Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }}
    >
      <img
        src="/landing/login-flow-bg.png"
        alt=""
        className="absolute inset-0 z-0 h-full w-full object-cover"
      />
      <div className="absolute inset-0 z-[1] bg-[linear-gradient(90deg,rgba(3,12,27,0.54)_0%,rgba(3,12,27,0.24)_50%,rgba(3,12,27,0.04)_100%)]" />
      <div className="absolute inset-0 z-[1] bg-[linear-gradient(180deg,rgba(2,8,23,0.32)_0%,rgba(2,8,23,0.02)_45%,rgba(2,8,23,0.54)_100%)]" />

      <nav className="relative z-10 border-b border-white/10 bg-slate-950/75 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6 lg:h-20 lg:px-8">
          <Link href="/" className="flex items-center">
            <Image
              src="/logo.png"
              alt="ISAFlow"
              width={160}
              height={64}
              className="h-9 w-auto brightness-0 invert sm:h-10"
              priority
            />
          </Link>

          <Link
            href="/login"
            className="inline-flex items-center justify-center rounded-lg bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-teal-950/30 transition-colors hover:bg-teal-500"
          >
            Sign in
          </Link>
        </div>
      </nav>

      <main className="relative z-10 mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl items-center gap-8 px-4 py-8 sm:px-6 lg:min-h-[calc(100vh-5rem)] lg:grid-cols-[minmax(0,1fr)_minmax(380px,440px)] lg:gap-12 lg:px-8 lg:py-10">
        <section className="max-w-2xl text-white">
          <div className="mb-5 h-1 w-16 rounded-full bg-teal-300 shadow-[0_0_22px_rgba(45,212,191,0.45)] sm:mb-7" />
          <h1 className="max-w-xl text-3xl font-extrabold leading-[1.06] tracking-normal text-white drop-shadow-2xl sm:text-5xl lg:text-[3.35rem]">
            Be first in the flow.
          </h1>
          <p className="mt-4 max-w-xl text-sm leading-6 text-white/85 drop-shadow-lg sm:mt-6 sm:text-lg sm:leading-7">
            Join the early access list for a calmer way to manage accounting, compliance,
            payroll and client work in one{' '}
            <span className="font-semibold text-teal-200">intelligent platform.</span>
          </p>

          <div className="mt-9 hidden max-w-xl grid-cols-2 gap-3 sm:grid">
            {capabilities.map(({ label, icon: Icon }) => (
              <div
                key={label}
                className="flex items-center gap-3 rounded-lg border border-white/[0.14] bg-slate-950/[0.18] px-4 py-3 text-sm font-semibold text-white/90 shadow-xl shadow-slate-950/10 backdrop-blur-md"
              >
                <Icon className="h-5 w-5 text-teal-200" strokeWidth={1.8} />
                {label}
              </div>
            ))}
          </div>
        </section>

        {children}
      </main>
    </div>
  );
}

export function WaitlistForm() {
  const [signupType, setSignupType] = useState<SignupType>('direct');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [practiceName, setPracticeName] = useState('');
  const [phone, setPhone] = useState('');
  const [annualTurnover, setAnnualTurnover] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const submittedEmail = String(formData.get('email') ?? '').trim().toLowerCase();
    const submittedAnnualTurnover = String(formData.get('annualTurnover') ?? '').trim();

    if (!submittedEmail) return;

    setError('');
    setSubmitting(true);

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: String(formData.get('name') ?? '').trim(),
          email: submittedEmail,
          companyName: String(formData.get('companyName') ?? '').trim(),
          practiceName: String(formData.get('practiceName') ?? '').trim(),
          phone: String(formData.get('phone') ?? '').trim(),
          signupType,
          // whole ZAR - the API converts to cents
          annualTurnover: submittedAnnualTurnover
            ? Number(submittedAnnualTurnover.replace(/[,\s]/g, ''))
            : undefined,
        }),
      });

      const json = (await res.json()) as ApiEnvelope;

      if (!res.ok || !json.success) {
        setError(json.error?.message ?? json.message ?? 'Something went wrong. Please try again.');
        return;
      }

      setDone(true);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <WaitlistPageShell>
        <div className="mx-auto w-full max-w-md lg:-mt-10">
          <div className="relative overflow-hidden rounded-2xl border border-white/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(248,250,252,0.88))] p-8 text-center shadow-[0_24px_70px_rgba(2,8,23,0.34)] backdrop-blur-2xl">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-teal-300/80 via-teal-500 to-cyan-300/70" />
            <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-full bg-teal-500/10">
              <CheckCircle2 className="h-6 w-6 text-teal-600" />
            </div>
            <h2 className="text-2xl font-bold tracking-normal text-slate-950">
              You&apos;re on the list
            </h2>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Thanks for your interest in ISAFlow. We&apos;re putting the finishing
              touches on the platform and will be in touch closer to launch to get you set up.
            </p>
            <Link
              href="/"
              className="mt-6 inline-flex items-center justify-center rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-teal-700 shadow-sm transition-colors hover:bg-slate-50"
            >
              Back to home
            </Link>
          </div>
        </div>
      </WaitlistPageShell>
    );
  }

  return (
    <WaitlistPageShell>
      <div className="mx-auto w-full max-w-md lg:-mt-10">
        <div className="mb-5 text-center text-white lg:text-left">
          <h2 className="text-2xl font-bold tracking-normal">Join the waitlist</h2>
          <p className="mt-1 text-sm text-white/70">
            Tell us who you are so we can invite the right teams first.
          </p>
        </div>

        <div className="relative overflow-hidden rounded-2xl border border-white/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.94),rgba(248,250,252,0.88))] p-6 shadow-[0_24px_70px_rgba(2,8,23,0.34)] backdrop-blur-2xl sm:p-8">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-teal-300/80 via-teal-500 to-cyan-300/70" />
          <form onSubmit={(e) => void handleSubmit(e)} noValidate>
            <div className="mb-4">
              <span className="mb-1.5 block text-xs font-semibold text-slate-700">
                I&apos;m signing up for
              </span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setSignupType('direct')}
                  disabled={submitting}
                  className={`rounded-lg border px-3 py-2.5 text-sm font-semibold transition ${
                    signupType === 'direct'
                      ? 'border-teal-500 bg-teal-500/10 text-teal-800'
                      : 'border-slate-300 bg-white/80 text-slate-600 hover:border-teal-400'
                  }`}
                >
                  My business
                </button>
                <button
                  type="button"
                  onClick={() => setSignupType('accountant')}
                  disabled={submitting}
                  className={`rounded-lg border px-3 py-2.5 text-sm font-semibold transition ${
                    signupType === 'accountant'
                      ? 'border-teal-500 bg-teal-500/10 text-teal-800'
                      : 'border-slate-300 bg-white/80 text-slate-600 hover:border-teal-400'
                  }`}
                >
                  Accountant
                </button>
              </div>
              <p className="mt-1.5 text-xs leading-5 text-slate-500">
                {signupType === 'accountant'
                  ? 'You manage accounting, payroll or advisory work for multiple client companies.'
                  : 'You run your own books for a single business.'}
              </p>
            </div>

            <div className="mb-4">
              <label htmlFor="name" className="mb-1.5 block text-xs font-semibold text-slate-700">
                Your name
              </label>
              <div className="relative">
                <UserRound className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="name"
                  name="name"
                  type="text"
                  autoComplete="name"
                  value={name}
                  onChange={(e) => { setError(''); setName(e.target.value); }}
                  disabled={submitting}
                  className="w-full rounded-lg border border-slate-300 !bg-white/95 px-10 py-3 text-sm !text-slate-950 shadow-sm shadow-slate-950/5 placeholder-slate-400 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50"
                  placeholder="John Doe"
                />
              </div>
            </div>

            <div className="mb-4">
              <label htmlFor="email" className="mb-1.5 block text-xs font-semibold text-slate-700">
                Email address <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => { setError(''); setEmail(e.target.value); }}
                  disabled={submitting}
                  className="w-full rounded-lg border border-slate-300 !bg-white/95 px-10 py-3 text-sm !text-slate-950 shadow-sm shadow-slate-950/5 placeholder-slate-400 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50"
                  placeholder="you@example.com"
                />
              </div>
            </div>

            {signupType === 'accountant' ? (
              <div className="mb-4">
                <label htmlFor="practiceName" className="mb-1.5 block text-xs font-semibold text-slate-700">
                  Practice name
                </label>
                <div className="relative">
                  <Building2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="practiceName"
                    name="practiceName"
                    type="text"
                    autoComplete="organization"
                    value={practiceName}
                    onChange={(e) => { setError(''); setPracticeName(e.target.value); }}
                    disabled={submitting}
                    className="w-full rounded-lg border border-slate-300 !bg-white/95 px-10 py-3 text-sm !text-slate-950 shadow-sm shadow-slate-950/5 placeholder-slate-400 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50"
                    placeholder="Smith & Associates"
                  />
                </div>
              </div>
            ) : (
              <div className="mb-4">
                <label htmlFor="companyName" className="mb-1.5 block text-xs font-semibold text-slate-700">
                  Company name
                </label>
                <div className="relative">
                  <Building2 className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="companyName"
                    name="companyName"
                    type="text"
                    autoComplete="organization"
                    value={companyName}
                    onChange={(e) => { setError(''); setCompanyName(e.target.value); }}
                    disabled={submitting}
                    className="w-full rounded-lg border border-slate-300 !bg-white/95 px-10 py-3 text-sm !text-slate-950 shadow-sm shadow-slate-950/5 placeholder-slate-400 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50"
                    placeholder="Acme (Pty) Ltd"
                  />
                </div>
              </div>
            )}

            <div className="mb-4">
              <label htmlFor="phone" className="mb-1.5 block text-xs font-semibold text-slate-700">
                Phone number
              </label>
              <div className="relative">
                <Phone className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="phone"
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => { setError(''); setPhone(e.target.value); }}
                  disabled={submitting}
                  className="w-full rounded-lg border border-slate-300 !bg-white/95 px-10 py-3 text-sm !text-slate-950 shadow-sm shadow-slate-950/5 placeholder-slate-400 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50"
                  placeholder="+27 82 000 0000"
                />
              </div>
            </div>

            {signupType === 'direct' && (
              <div className="mb-6">
                <label htmlFor="annualTurnover" className="mb-1.5 block text-xs font-semibold text-slate-700">
                  Annual turnover (ZAR) <span className="font-medium text-slate-400">- optional</span>
                </label>
                <div className="relative">
                  <CircleDollarSign className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="annualTurnover"
                    name="annualTurnover"
                    type="text"
                    inputMode="numeric"
                    value={annualTurnover}
                    onChange={(e) => { setError(''); setAnnualTurnover(e.target.value.replace(/[^0-9,\s]/g, '')); }}
                    disabled={submitting}
                    className="w-full rounded-lg border border-slate-300 !bg-white/95 px-10 py-3 text-sm !text-slate-950 shadow-sm shadow-slate-950/5 placeholder-slate-400 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50"
                    placeholder="500 000"
                  />
                </div>
                {annualTurnover && Number(annualTurnover.replace(/[,\s]/g, '')) > 0 && Number(annualTurnover.replace(/[,\s]/g, '')) < 1_000_000 ? (
                  <p className="mt-1.5 text-xs leading-5 text-teal-700">
                    Under R1M - you&apos;ll qualify for our Pay-As-You-Go plan.
                  </p>
                ) : (
                  <p className="mt-1.5 text-xs leading-5 text-slate-500">
                    Helps us suggest the best plan when we open doors.
                  </p>
                )}
              </div>
            )}

            {error && (
              <div className="mb-4 rounded-lg border border-red-500/30 bg-red-50 px-3 py-2.5">
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-teal-700 to-teal-600 px-4 py-3.5 text-sm font-semibold text-white shadow-lg shadow-teal-950/25 transition hover:from-teal-600 hover:to-teal-500 disabled:cursor-not-allowed disabled:from-teal-900/70 disabled:to-teal-800/70"
            >
              {submitting ? (
                <>
                  <LoadingSpinner size="sm" />
                  <span>Submitting...</span>
                </>
              ) : (
                'Join early access'
              )}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-white/75">
          Already have an account?{' '}
          <Link href="/login" className="font-semibold text-teal-100 transition-colors hover:text-white">
            Sign in
          </Link>
        </p>
      </div>
    </WaitlistPageShell>
  );
}
