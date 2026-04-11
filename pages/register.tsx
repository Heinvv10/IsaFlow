/**
 * /register — Create a new ISAFlow account.
 * Supports ?invite=[token] to pre-fill email and show an invite banner.
 *
 * On success we auto-sign-in the new user (same credentials they just typed)
 * and route them straight into the onboarding wizard — no second password
 * prompt. If auto-login somehow fails (e.g. 2FA required, network blip) we
 * fall back to the classic /login redirect with a success banner.
 */

import { useState, useEffect, FormEvent } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Image from 'next/image';
import { Eye, EyeOff, Building2 } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

interface StrengthResult {
  score: number;
  label: string;
  hint: string;
}

function checkClientPasswordStrength(password: string): StrengthResult {
  if (password.length < 8) {
    return { score: 0, label: 'Too short', hint: 'Must be at least 8 characters' };
  }

  let score = 1;

  const hasLower = /[a-z]/.test(password);
  const hasUpper = /[A-Z]/.test(password);
  if (hasLower && hasUpper) score = 2;
  else {
    return { score: 1, label: 'Weak', hint: 'Add uppercase and lowercase letters' };
  }

  const hasNumber = /[0-9]/.test(password);
  if (hasNumber) score = 3;
  else {
    return { score: 2, label: 'Fair', hint: 'Add a number' };
  }

  const hasSpecial = /[^a-zA-Z0-9]/.test(password);
  if (hasSpecial) score = 4;
  else {
    return { score: 3, label: 'Good', hint: 'Add a special character for maximum strength' };
  }

  return { score: 4, label: 'Strong', hint: '' };
}

interface InviteData {
  email: string;
  companyName: string;
  role: string;
}

const STRENGTH_COLORS = ['bg-red-500', 'bg-red-500', 'bg-yellow-500', 'bg-green-500', 'bg-teal-500'];

export default function RegisterPage() {
  const router = useRouter();
  const { login } = useAuth();

  const inviteToken =
    typeof router.query.invite === 'string' ? router.query.invite : null;

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [inviteData, setInviteData] = useState<InviteData | null>(null);

  const strength = password ? checkClientPasswordStrength(password) : null;

  // Load invite data when token is present.
  // NOTE: the API returns the invitee's email in MASKED form (e.g. "f***@x.com")
  // to prevent enumeration via the public token URL, so we must NOT pre-fill or
  // lock the email field from it. The user has to type their real email and the
  // server-side invite-accept step will verify it matches the stored invitation.
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

  // Fallback destination when auto-login can't be used (2FA, network error).
  const fallbackLoginUrl = inviteToken
    ? `/login?registered=1&invite=${inviteToken}`
    : '/login?registered=1';

  // Accept the invite (if present) now that the user is authenticated, then
  // figure out where to send them:
  // - Came from an invite → accept → /accounting (they're in an existing company)
  // - No companies yet → /onboarding wizard
  // - Already has a company → /accounting
  const postRegisterRedirect = async (): Promise<string> => {
    if (inviteToken) {
      try {
        const acceptRes = await fetch(`/api/invite/${inviteToken}`, {
          method: 'POST',
          credentials: 'include',
        });
        if (acceptRes.ok) {
          // Invitation accepted — the user is now in the inviting company.
          return '/accounting';
        }
        // 403 usually means "this invitation was sent to a different email".
        // Surface the server message to the user instead of silently landing
        // them on the wrong screen.
        const body = (await acceptRes.json().catch(() => ({}))) as {
          error?: { message?: string };
        };
        setError(
          body.error?.message ??
            'Could not accept the invitation. It may have expired or been sent to a different email.',
        );
        // Fall through to /accounting anyway — they have a valid session.
      } catch {
        // Network error on accept — non-fatal, let them into the app.
      }
    }

    try {
      const res = await fetch('/api/accounting/companies?action=user-companies', {
        credentials: 'include',
      });
      if (res.ok) {
        const body = (await res.json()) as { data?: { items?: unknown[] } };
        const items = body.data?.items;
        if (Array.isArray(items) && items.length === 0) return '/onboarding';
      }
    } catch {
      // Non-fatal — let the caller fall through to a safe default.
    }
    return '/accounting';
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);

    const trimmedEmail = email.trim().toLowerCase();

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: trimmedEmail,
          password,
          confirmPassword,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error?.message || data.message || 'Registration failed');
        return;
      }

      // Auto-sign-in so the user doesn't have to retype credentials they
      // literally typed 2 seconds ago. The register endpoint does NOT set
      // a session cookie, so we POST to /api/auth/login via AuthContext.
      try {
        const needs2FA = await login(trimmedEmail, password);
        if (needs2FA) {
          // User has 2FA set up via a prior account — fall back so the
          // /login 2FA screen can take over. Should be very rare on a
          // brand-new account, but kept as a safety hatch.
          await router.push(fallbackLoginUrl);
          return;
        }
        await router.push(await postRegisterRedirect());
      } catch {
        // Auto-login failed (rate-limit, transient error) — show the
        // manual login page with the success banner so the user can
        // still sign in.
        await router.push(fallbackLoginUrl);
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const canSubmit = firstName && lastName && email && password && confirmPassword && !submitting;

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <Image src="/logo.png" alt="ISAFlow" width={160} height={64} className="h-16 w-auto brightness-0 invert mb-4" priority />
          <p className="text-sm text-gray-500 mt-1">Create your account</p>
        </div>

        {/* Invite banner */}
        {inviteData && (
          <div className="mb-4 px-4 py-3 bg-teal-900/30 border border-teal-700/50 rounded-lg flex items-start gap-3">
            <Building2 className="h-4 w-4 text-teal-400 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-teal-300">
              Create an account to join{' '}
              <span className="font-medium text-white">{inviteData.companyName}</span>
              {' '}as <span className="font-medium">{inviteData.role}</span>.
            </p>
          </div>
        )}

        {/* Card */}
        <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 shadow-xl">
          <form onSubmit={(e) => void handleSubmit(e)} noValidate>

            {/* First Name + Last Name */}
            <div className="flex gap-3 mb-4">
              <div className="flex-1">
                <label htmlFor="firstName" className="block text-xs font-medium text-gray-400 mb-1.5">
                  First Name
                </label>
                <input
                  id="firstName"
                  type="text"
                  autoComplete="given-name"
                  required
                  value={firstName}
                  onChange={e => { setError(''); setFirstName(e.target.value); }}
                  disabled={submitting}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
                  placeholder="John"
                />
              </div>
              <div className="flex-1">
                <label htmlFor="lastName" className="block text-xs font-medium text-gray-400 mb-1.5">
                  Last Name
                </label>
                <input
                  id="lastName"
                  type="text"
                  autoComplete="family-name"
                  required
                  value={lastName}
                  onChange={e => { setError(''); setLastName(e.target.value); }}
                  disabled={submitting}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
                  placeholder="Doe"
                />
              </div>
            </div>

            {/* Email */}
            <div className="mb-4">
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
              {inviteData && (
                <p className="mt-1 text-xs text-gray-500">
                  Enter the email address this invitation was sent to
                  ({inviteData.email}).
                </p>
              )}
            </div>

            {/* Password */}
            <div className="mb-4">
              <label htmlFor="password" className="block text-xs font-medium text-gray-400 mb-1.5">
                Password
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
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 pr-10 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
                  placeholder="Choose a password"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-500 hover:text-gray-300 transition-colors"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              {/* Password strength indicator */}
              {password && strength && (
                <div className="mt-2">
                  <div className="flex gap-1 mb-1">
                    {[0, 1, 2, 3].map(i => (
                      <div
                        key={i}
                        className={`h-1 flex-1 rounded-full transition-colors ${
                          i < strength.score ? STRENGTH_COLORS[strength.score] : 'bg-gray-700'
                        }`}
                      />
                    ))}
                  </div>
                  {strength.hint && (
                    <p className="text-xs text-gray-500">{strength.hint}</p>
                  )}
                </div>
              )}
            </div>

            {/* Confirm Password */}
            <div className="mb-6">
              <label htmlFor="confirmPassword" className="block text-xs font-medium text-gray-400 mb-1.5">
                Confirm password
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
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 pr-10 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
                  placeholder="Confirm your password"
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowConfirm(v => !v)}
                  className="absolute inset-y-0 right-0 flex items-center px-3 text-gray-500 hover:text-gray-300 transition-colors"
                  aria-label={showConfirm ? 'Hide password' : 'Show password'}
                >
                  {showConfirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
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
              disabled={!canSubmit}
              className="w-full flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-500 disabled:bg-teal-800 disabled:cursor-not-allowed text-white font-medium text-sm px-4 py-2.5 rounded-lg transition-colors"
            >
              {submitting ? (
                <>
                  <LoadingSpinner size="sm" />
                  <span>Creating Account...</span>
                </>
              ) : (
                'Create Account'
              )}
            </button>
          </form>
        </div>

        {/* Footer link */}
        <p className="text-center text-sm text-gray-500 mt-6">
          Already have an account?{' '}
          <Link
            href={inviteToken ? `/login?invite=${inviteToken}` : '/login'}
            className="text-teal-400 hover:text-teal-300 transition-colors"
          >
            Sign in
          </Link>
        </p>

      </div>
    </div>
  );
}
