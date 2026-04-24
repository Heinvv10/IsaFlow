/**
 * WaitlistForm — pre-launch lead capture shown on the public /register route
 * (and any "Sign up" CTA) until we're ready to take paying customers.
 *
 * Posts to /api/waitlist and swaps to a thank-you state on success.
 */

import { useState, FormEvent } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { CheckCircle2 } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

interface ApiEnvelope {
  success: boolean;
  message?: string;
  error?: { message?: string };
}

type SignupType = 'direct' | 'accountant';

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

  const canSubmit = email.trim().length > 0 && !submitting;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const res = await fetch('/api/waitlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim().toLowerCase(),
          companyName: companyName.trim(),
          practiceName: practiceName.trim(),
          phone: phone.trim(),
          signupType,
          // whole ZAR — the API converts to cents
          annualTurnover: annualTurnover.trim() ? Number(annualTurnover.replace(/[,\s]/g, '')) : undefined,
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
      <div className="min-h-screen bg-slate-50 dark:bg-gray-950 flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="flex flex-col items-center mb-8">
            <Image src="/logo.png" alt="ISAFlow" width={160} height={64} className="h-16 w-auto dark:brightness-0 dark:invert mb-4" priority />
          </div>

          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl p-8 shadow-xl text-center">
            <div className="mx-auto w-12 h-12 rounded-full bg-teal-500/10 flex items-center justify-center mb-4">
              <CheckCircle2 className="w-6 h-6 text-teal-500" />
            </div>
            <h1 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">
              You&apos;re on the list
            </h1>
            <p className="text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
              Thanks for your interest in ISAFlow. We&apos;re putting the finishing
              touches on the platform and will be in touch closer to launch to
              get you set up.
            </p>
            <Link
              href="/"
              className="mt-6 inline-block text-sm text-teal-600 hover:text-teal-500 dark:text-teal-400 dark:hover:text-teal-300 transition-colors"
            >
              Back to home
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-950 flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">

        <div className="flex flex-col items-center mb-8">
          <Image src="/logo.png" alt="ISAFlow" width={160} height={64} className="h-16 w-auto dark:brightness-0 dark:invert mb-4" priority />
          <h1 className="text-lg font-semibold text-slate-900 dark:text-white mt-2">
            Join the waitlist
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-300 mt-1 text-center">
            We&apos;re not quite taking new customers yet. Leave your details
            and we&apos;ll be in touch closer to launch.
          </p>
        </div>

        <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl p-6 shadow-xl">
          <form onSubmit={(e) => void handleSubmit(e)} noValidate>

            <div className="mb-4">
              <span className="block text-xs font-medium text-slate-500 dark:text-gray-400 mb-1.5">
                I&apos;m signing up for
              </span>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setSignupType('direct')}
                  disabled={submitting}
                  className={`px-3 py-2.5 rounded-lg border text-sm transition ${signupType === 'direct'
                    ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                    : 'border-slate-300 dark:border-gray-600 bg-slate-50 dark:bg-gray-800 text-slate-600 dark:text-gray-300 hover:border-teal-400'}`}
                >
                  My own business
                </button>
                <button
                  type="button"
                  onClick={() => setSignupType('accountant')}
                  disabled={submitting}
                  className={`px-3 py-2.5 rounded-lg border text-sm transition ${signupType === 'accountant'
                    ? 'border-teal-500 bg-teal-500/10 text-teal-700 dark:text-teal-300'
                    : 'border-slate-300 dark:border-gray-600 bg-slate-50 dark:bg-gray-800 text-slate-600 dark:text-gray-300 hover:border-teal-400'}`}
                >
                  I&apos;m an accountant
                </button>
              </div>
              <p className="text-xs text-slate-500 dark:text-gray-500 mt-1.5">
                {signupType === 'accountant'
                  ? 'You manage payroll/accounting for multiple client companies — get the bureau dashboard.'
                  : 'You run your own books for a single business.'}
              </p>
            </div>

            <div className="mb-4">
              <label htmlFor="name" className="block text-xs font-medium text-slate-500 dark:text-gray-400 mb-1.5">
                Your name
              </label>
              <input
                id="name"
                type="text"
                autoComplete="name"
                value={name}
                onChange={(e) => { setError(''); setName(e.target.value); }}
                disabled={submitting}
                className="w-full bg-slate-50 dark:bg-gray-800 border border-slate-300 dark:border-gray-600 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
                placeholder="John Doe"
              />
            </div>

            <div className="mb-4">
              <label htmlFor="email" className="block text-xs font-medium text-slate-500 dark:text-gray-400 mb-1.5">
                Email address <span className="text-red-500">*</span>
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => { setError(''); setEmail(e.target.value); }}
                disabled={submitting}
                className="w-full bg-slate-50 dark:bg-gray-800 border border-slate-300 dark:border-gray-600 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
                placeholder="you@example.com"
              />
            </div>

            {signupType === 'accountant' ? (
              <div className="mb-4">
                <label htmlFor="practiceName" className="block text-xs font-medium text-slate-500 dark:text-gray-400 mb-1.5">
                  Practice name
                </label>
                <input
                  id="practiceName"
                  type="text"
                  autoComplete="organization"
                  value={practiceName}
                  onChange={(e) => { setError(''); setPracticeName(e.target.value); }}
                  disabled={submitting}
                  className="w-full bg-slate-50 dark:bg-gray-800 border border-slate-300 dark:border-gray-600 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
                  placeholder="Smith & Associates"
                />
              </div>
            ) : (
              <div className="mb-4">
                <label htmlFor="companyName" className="block text-xs font-medium text-slate-500 dark:text-gray-400 mb-1.5">
                  Company name
                </label>
                <input
                  id="companyName"
                  type="text"
                  autoComplete="organization"
                  value={companyName}
                  onChange={(e) => { setError(''); setCompanyName(e.target.value); }}
                  disabled={submitting}
                  className="w-full bg-slate-50 dark:bg-gray-800 border border-slate-300 dark:border-gray-600 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
                  placeholder="Acme (Pty) Ltd"
                />
              </div>
            )}

            <div className="mb-4">
              <label htmlFor="phone" className="block text-xs font-medium text-slate-500 dark:text-gray-400 mb-1.5">
                Phone number
              </label>
              <input
                id="phone"
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => { setError(''); setPhone(e.target.value); }}
                disabled={submitting}
                className="w-full bg-slate-50 dark:bg-gray-800 border border-slate-300 dark:border-gray-600 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
                placeholder="+27 82 000 0000"
              />
            </div>

            {signupType === 'direct' && (
              <div className="mb-6">
                <label htmlFor="annualTurnover" className="block text-xs font-medium text-slate-500 dark:text-gray-400 mb-1.5">
                  Annual turnover (ZAR) <span className="text-slate-400 dark:text-gray-500">— optional</span>
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400 dark:text-gray-500">R</span>
                  <input
                    id="annualTurnover"
                    type="text"
                    inputMode="numeric"
                    value={annualTurnover}
                    onChange={(e) => { setError(''); setAnnualTurnover(e.target.value.replace(/[^0-9,\s]/g, '')); }}
                    disabled={submitting}
                    className="w-full bg-slate-50 dark:bg-gray-800 border border-slate-300 dark:border-gray-600 rounded-lg pl-7 pr-3 py-2.5 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
                    placeholder="500 000"
                  />
                </div>
                {annualTurnover && Number(annualTurnover.replace(/[,\s]/g, '')) > 0 && Number(annualTurnover.replace(/[,\s]/g, '')) < 1_000_000 ? (
                  <p className="text-xs text-teal-600 dark:text-teal-400 mt-1.5">
                    Under R1M — you&apos;ll qualify for our Pay-As-You-Go plan (pay only for what you use).
                  </p>
                ) : (
                  <p className="text-xs text-slate-500 dark:text-gray-500 mt-1.5">
                    Helps us suggest the best plan when we open doors.
                  </p>
                )}
              </div>
            )}

            {error && (
              <div className="mb-4 px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={!canSubmit}
              className="w-full flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-500 disabled:bg-teal-800 disabled:cursor-not-allowed text-white font-medium text-sm px-4 py-2.5 rounded-lg transition-colors"
            >
              {submitting ? (
                <>
                  <LoadingSpinner size="sm" />
                  <span>Submitting...</span>
                </>
              ) : (
                'Notify me when you launch'
              )}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-slate-500 dark:text-gray-500 mt-6">
          Already have an account?{' '}
          <Link href="/login" className="text-teal-500 hover:text-teal-400 transition-colors">
            Sign in
          </Link>
        </p>

      </div>
    </div>
  );
}
