/**
 * /forgot-password — Request a password reset email.
 */

import { useState, FormEvent } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { Mail } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    try {
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase() }),
      });

      if (res.status === 429) {
        setError('Too many requests. Please wait a few minutes and try again.');
        return;
      }

      // Always show success (server returns 200 even for unknown emails)
      setSent(true);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <Image src="/logo.png" alt="ISAFlow" width={160} height={64} className="h-16 w-auto brightness-0 invert mb-4" priority />
          <p className="text-sm text-gray-500 mt-1">Reset your password</p>
        </div>

        {sent ? (
          /* Success state */
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 shadow-xl text-center">
            <div className="flex justify-center mb-4">
              <div className="p-3 bg-teal-500/10 rounded-full">
                <Mail className="h-8 w-8 text-teal-400" />
              </div>
            </div>
            <h2 className="text-lg font-semibold text-white mb-2">Check your email</h2>
            <p className="text-sm text-gray-400 leading-relaxed">
              If an account exists for{' '}
              <span className="text-white font-medium">{email}</span>,
              we&apos;ve sent a reset link. It expires in 1 hour.
            </p>
            <p className="text-xs text-gray-500 mt-4">
              Didn&apos;t get it? Check your spam folder or{' '}
              <button
                type="button"
                onClick={() => setSent(false)}
                className="text-teal-400 hover:text-teal-300 underline transition-colors"
              >
                try again
              </button>
              .
            </p>
          </div>
        ) : (
          /* Request form */
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 shadow-xl">
            <p className="text-sm text-gray-400 mb-5 leading-relaxed">
              Enter your email address and we&apos;ll send you a link to reset your password.
            </p>

            <form onSubmit={(e) => void handleSubmit(e)} noValidate>
              <div className="mb-5">
                <label htmlFor="email" className="block text-xs font-medium text-gray-400 mb-1.5">
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={e => { setError(''); setEmail(e.target.value); }}
                  disabled={submitting}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
                  placeholder="you@example.com"
                />
              </div>

              {error && (
                <div className="mb-4 px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg">
                  <p className="text-sm text-red-400">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !email}
                className="w-full flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-500 disabled:bg-teal-800 disabled:cursor-not-allowed text-white font-medium text-sm px-4 py-2.5 rounded-lg transition-colors"
              >
                {submitting ? (
                  <>
                    <LoadingSpinner size="sm" />
                    <span>Sending...</span>
                  </>
                ) : (
                  'Send Reset Link'
                )}
              </button>
            </form>
          </div>
        )}

        {/* Back to login */}
        <p className="text-center text-sm text-gray-500 mt-6">
          <Link href="/login" className="text-teal-400 hover:text-teal-300 transition-colors">
            &larr; Back to sign in
          </Link>
        </p>

      </div>
    </div>
  );
}
