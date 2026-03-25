/**
 * /login — Email + password sign-in page.
 * Redirects to /accounting on success; shows inline error on failure.
 * Unauthenticated users land here via middleware or manual navigation.
 */

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/router';
import { BookOpen, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

export default function LoginPage() {
  const router = useRouter();
  const { login, error, clearError } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const returnTo =
    typeof router.query.returnTo === 'string' ? router.query.returnTo : '/accounting';

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    clearError();
    setSubmitting(true);

    try {
      await login(email.trim().toLowerCase(), password);
      await router.push(returnTo);
    } catch {
      // Error is already set in AuthContext — no further action needed here
    } finally {
      setSubmitting(false);
    }
  };

  const isBusy = submitting;

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 bg-emerald-600 rounded-xl flex items-center justify-center mb-3">
            <BookOpen className="w-6 h-6 text-white" />
          </div>
          <h1 className="text-xl font-semibold text-white">Accounting</h1>
          <p className="text-sm text-gray-500 mt-1">Sign in to your account</p>
        </div>

        {/* Card */}
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 shadow-xl">
          <form onSubmit={(e) => void handleSubmit(e)} noValidate>

            {/* Email */}
            <div className="mb-4">
              <label
                htmlFor="email"
                className="block text-xs font-medium text-gray-400 mb-1.5"
              >
                Email address
              </label>
              <input
                id="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={e => { clearError(); setEmail(e.target.value); }}
                disabled={isBusy}
                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent disabled:opacity-50 transition"
                placeholder="you@example.com"
              />
            </div>

            {/* Password */}
            <div className="mb-6">
              <label
                htmlFor="password"
                className="block text-xs font-medium text-gray-400 mb-1.5"
              >
                Password
              </label>
              <div className="relative">
                <input
                  id="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={e => { clearError(); setPassword(e.target.value); }}
                  disabled={isBusy}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 pr-10 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent disabled:opacity-50 transition"
                  placeholder="Enter your password"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-500 hover:text-gray-300 transition-colors"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword
                    ? <EyeOff className="w-4 h-4" />
                    : <Eye className="w-4 h-4" />
                  }
                </button>
              </div>
            </div>

            {/* Error message */}
            {error && (
              <div className="mb-4 px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            {/* Submit */}
            <button
              type="submit"
              disabled={isBusy || !email || !password}
              className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-emerald-800 disabled:cursor-not-allowed text-white font-medium text-sm px-4 py-2.5 rounded-lg transition-colors"
            >
              {isBusy ? (
                <>
                  <LoadingSpinner size="sm" />
                  <span>Signing in...</span>
                </>
              ) : (
                'Sign in'
              )}
            </button>
          </form>
        </div>

      </div>
    </div>
  );
}
