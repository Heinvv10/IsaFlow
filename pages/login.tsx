/**
 * /login — Email + password sign-in page.
 * Supports ?invite=[token] to show an invitation banner.
 * Redirects to /accounting on success; shows inline error on failure.
 */

import { useState, useEffect, FormEvent } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { Eye, EyeOff, Building2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

interface InviteData {
  companyName: string;
  role: string;
  invitedBy: string;
}

export default function LoginPage() {
  const router = useRouter();
  const { login, error, clearError } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [inviteData, setInviteData] = useState<InviteData | null>(null);

  const inviteToken =
    typeof router.query.invite === 'string' ? router.query.invite : null;

  const returnTo =
    typeof router.query.returnTo === 'string' && router.query.returnTo.startsWith('/')
      ? router.query.returnTo
      : '/accounting';

  // Load invite data when token is present
  useEffect(() => {
    if (!inviteToken) return;

    fetch(`/api/invite/${inviteToken}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (json?.data) {
          setInviteData(json.data as InviteData);
        }
      })
      .catch(() => null);
  }, [inviteToken]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    clearError();
    setSubmitting(true);

    try {
      await login(email.trim().toLowerCase(), password);
      // After login the API auto-accepts any pending invitations,
      // so just redirect straight to accounting.
      await router.push(returnTo);
    } catch {
      // Error is already set in AuthContext
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
          <img src="/logo.png" alt="ISAFlow" className="h-16 w-auto brightness-0 invert mb-4" />
          <p className="text-sm text-gray-500 mt-1">Sign in to your account</p>
        </div>

        {/* Invite banner */}
        {inviteData && (
          <div className="mb-4 px-4 py-3 bg-teal-900/30 border border-teal-700/50 rounded-lg flex items-start gap-3">
            <Building2 className="h-4 w-4 text-teal-400 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-teal-300">
              You&apos;ve been invited to join{' '}
              <span className="font-medium text-white">{inviteData.companyName}</span>
              {' '}as <span className="font-medium">{inviteData.role}</span>.
              Sign in to accept.
            </p>
          </div>
        )}

        {/* Registration success banner */}
        {router.query.registered === '1' && (
          <div className="mb-4 px-3 py-2.5 bg-green-500/10 border border-green-500/30 rounded-lg">
            <p className="text-sm text-green-400">Account created successfully! Please sign in.</p>
          </div>
        )}

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
                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
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
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 pr-10 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
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
              className="w-full flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-500 disabled:bg-teal-800 disabled:cursor-not-allowed text-white font-medium text-sm px-4 py-2.5 rounded-lg transition-colors"
            >
              {isBusy ? (
                <>
                  <LoadingSpinner size="sm" />
                  <span>Signing In...</span>
                </>
              ) : (
                'Sign In'
              )}
            </button>
          </form>
        </div>

        {/* Footer link */}
        <p className="text-center text-sm text-gray-500 mt-6">
          Don&apos;t have an account?{' '}
          <Link
            href={inviteToken ? `/register?invite=${inviteToken}` : '/register'}
            className="text-teal-400 hover:text-teal-300 transition-colors"
          >
            Create one
          </Link>
        </p>

      </div>
    </div>
  );
}
