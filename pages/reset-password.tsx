/**
 * /reset-password?token=<token>
 * Validates the reset token and lets the user choose a new password.
 */

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Image from 'next/image';
import { Eye, EyeOff, CheckCircle } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

interface StrengthResult {
  score: number;
  label: string;
  hint: string;
}

function checkStrength(password: string): StrengthResult {
  if (password.length < 8) {
    return { score: 0, label: 'Too short', hint: 'Must be at least 8 characters' };
  }
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) {
    return { score: 1, label: 'Weak', hint: 'Add uppercase and lowercase letters' };
  }
  if (!/[0-9]/.test(password)) {
    return { score: 2, label: 'Fair', hint: 'Add a number' };
  }
  if (!/[^a-zA-Z0-9]/.test(password)) {
    return { score: 3, label: 'Good', hint: 'Add a special character for maximum strength' };
  }
  return { score: 4, label: 'Strong', hint: '' };
}

const STRENGTH_COLORS = ['bg-red-500', 'bg-red-500', 'bg-yellow-500', 'bg-green-500', 'bg-teal-500'];

export default function ResetPasswordPage() {
  const router = useRouter();
  const token = typeof router.query.token === 'string' ? router.query.token : '';

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const strength = password ? checkStrength(password) : null;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (!token) {
      setError('Invalid reset link. Please request a new one.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/do-reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password, confirmPassword }),
      });

      const data = await res.json() as { error?: { message?: string }; message?: string };

      if (!res.ok) {
        setError(data.error?.message || 'Failed to reset password. Please try again.');
        return;
      }

      setDone(true);
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (!token) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-gray-950 flex items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          <p className="text-red-400 mb-4">Invalid reset link.</p>
          <Link href="/forgot-password" className="text-teal-400 hover:text-teal-300 transition-colors text-sm">
            Request a new one
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <Image src="/logo.png" alt="ISAFlow" width={160} height={64} className="h-16 w-auto dark:brightness-0 dark:invert mb-4" priority />
          <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">Choose a new password</p>
        </div>

        {done ? (
          /* Success state */
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl p-6 shadow-xl text-center">
            <div className="flex justify-center mb-4">
              <div className="p-3 bg-teal-500/10 rounded-full">
                <CheckCircle className="h-8 w-8 text-teal-400" />
              </div>
            </div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white mb-2">Password updated</h2>
            <p className="text-sm text-slate-600 dark:text-gray-400 mb-5">
              Your password has been changed successfully.
            </p>
            <Link
              href="/login"
              className="inline-block w-full text-center bg-teal-600 hover:bg-teal-500 text-white font-medium text-sm px-4 py-2.5 rounded-lg transition-colors"
            >
              Sign in
            </Link>
          </div>
        ) : (
          /* Reset form */
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl p-6 shadow-xl">
            <form onSubmit={(e) => void handleSubmit(e)} noValidate>

              {/* New Password */}
              <div className="mb-4">
                <label htmlFor="password" className="block text-xs font-medium text-slate-500 dark:text-gray-400 mb-1.5">
                  New Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                    value={password}
                    onChange={e => { setError(''); setPassword(e.target.value); }}
                    disabled={submitting}
                    className="w-full bg-slate-50 dark:bg-gray-800 border border-slate-300 dark:border-gray-600 rounded-lg px-3 py-2.5 pr-10 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
                    placeholder="Choose a strong password"
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowPassword(v => !v)}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-500 dark:text-slate-400 dark:text-gray-500 hover:text-slate-600 dark:hover:text-gray-300 transition-colors"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>

                {/* Strength bar */}
                {password && strength && (
                  <div className="mt-2">
                    <div className="flex gap-1 mb-1">
                      {[0, 1, 2, 3].map(i => (
                        <div
                          key={i}
                          className={`h-1 flex-1 rounded-full transition-colors ${ i < strength.score ? STRENGTH_COLORS[strength.score] : 'bg-slate-200 dark:bg-gray-700' }`}
                        />
                      ))}
                    </div>
                    {strength.hint && (
                      <p className="text-xs text-slate-500 dark:text-gray-500">{strength.hint}</p>
                    )}
                  </div>
                )}
              </div>

              {/* Confirm Password */}
              <div className="mb-6">
                <label htmlFor="confirmPassword" className="block text-xs font-medium text-slate-500 dark:text-gray-400 mb-1.5">
                  Confirm Password
                </label>
                <div className="relative">
                  <input
                    id="confirmPassword"
                    type={showConfirm ? 'text' : 'password'}
                    autoComplete="new-password"
                    required
                    value={confirmPassword}
                    onChange={e => { setError(''); setConfirmPassword(e.target.value); }}
                    disabled={submitting}
                    className="w-full bg-slate-50 dark:bg-gray-800 border border-slate-300 dark:border-gray-600 rounded-lg px-3 py-2.5 pr-10 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
                    placeholder="Confirm your password"
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowConfirm(v => !v)}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-500 dark:text-slate-400 dark:text-gray-500 hover:text-slate-600 dark:hover:text-gray-300 transition-colors"
                    aria-label={showConfirm ? 'Hide password' : 'Show password'}
                  >
                    {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {error && (
                <div className="mb-4 px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg">
                  <p className="text-sm text-red-400">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !password || !confirmPassword}
                className="w-full flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-500 disabled:bg-teal-800 disabled:cursor-not-allowed text-white font-medium text-sm px-4 py-2.5 rounded-lg transition-colors"
              >
                {submitting ? (
                  <>
                    <LoadingSpinner size="sm" />
                    <span>Updating...</span>
                  </>
                ) : (
                  'Update Password'
                )}
              </button>
            </form>
          </div>
        )}

        <p className="text-center text-sm text-slate-500 dark:text-gray-500 mt-6">
          <Link href="/login" className="text-teal-400 hover:text-teal-300 transition-colors">
            &larr; Back to sign in
          </Link>
        </p>

      </div>
    </div>
  );
}
