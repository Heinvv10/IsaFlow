/**
 * /login — Email + password sign-in page.
 * Supports ?invite=[token] to show an invitation banner.
 * Redirects to /accounting on success; shows 2FA challenge if required.
 */

import { useState, useEffect, useRef, FormEvent } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import { Eye, EyeOff, Building2, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

interface InviteData {
  companyName: string;
  role: string;
  invitedBy: string;
}

// ── Device Fingerprint ────────────────────────────────────────────────────────

function getDeviceFingerprint(): string {
  if (typeof window === 'undefined') return 'ssr';
  const nav = window.navigator;
  const raw = [
    nav.userAgent,
    nav.language,
    screen.colorDepth,
    screen.width,
    screen.height,
    new Date().getTimezoneOffset(),
    !!nav.cookieEnabled,
  ].join('|');
  // Simple djb2 hash
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash) ^ raw.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

function getDeviceName(): string {
  if (typeof window === 'undefined') return 'Unknown Device';
  const ua = window.navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android Device';
  if (/Mac/.test(ua)) return 'Mac';
  if (/Windows/.test(ua)) return 'Windows PC';
  if (/Linux/.test(ua)) return 'Linux PC';
  return 'Unknown Device';
}

// ── 2FA Screen ────────────────────────────────────────────────────────────────

function TwoFactorScreen({
  onVerify,
  loading,
  error,
}: {
  onVerify: (code: string, trustDevice: boolean) => Promise<void>;
  loading: boolean;
  error: string | null;
}) {
  const [code, setCode] = useState('');
  const [trustDevice, setTrustDevice] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (code.trim().length < 6) return;
    await onVerify(code.trim(), trustDevice);
  };

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 shadow-xl">
      <div className="flex flex-col items-center mb-6">
        <div className="p-3 bg-teal-500/10 rounded-full mb-3">
          <ShieldCheck className="h-8 w-8 text-teal-400" />
        </div>
        <h2 className="text-lg font-semibold text-white">Two-Factor Authentication</h2>
        <p className="text-sm text-gray-400 mt-1 text-center">
          Enter the 6-digit code from your authenticator app, or a backup code.
        </p>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} noValidate>
        <div className="mb-4">
          <label htmlFor="code" className="block text-xs font-medium text-gray-400 mb-1.5">
            Authentication Code
          </label>
          <input
            id="code"
            ref={inputRef}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={10}
            value={code}
            onChange={e => setCode(e.target.value.replace(/\s/g, ''))}
            disabled={loading}
            placeholder="000000"
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition text-center tracking-widest font-mono text-lg"
          />
        </div>

        <div className="mb-6 flex items-center gap-2">
          <input
            id="trust-device"
            type="checkbox"
            checked={trustDevice}
            onChange={e => setTrustDevice(e.target.checked)}
            className="rounded border-gray-600 bg-gray-800 text-teal-500 focus:ring-teal-500"
          />
          <label htmlFor="trust-device" className="text-sm text-gray-400 cursor-pointer">
            Trust this device for 30 days
          </label>
        </div>

        {error && (
          <div className="mb-4 px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg">
            <p className="text-sm text-red-400">{error}</p>
          </div>
        )}

        <button
          type="submit"
          disabled={loading || code.trim().length < 6}
          className="w-full flex items-center justify-center gap-2 bg-teal-600 hover:bg-teal-500 disabled:bg-teal-800 disabled:cursor-not-allowed text-white font-medium text-sm px-4 py-2.5 rounded-lg transition-colors"
        >
          {loading ? (
            <>
              <LoadingSpinner size="sm" />
              <span>Verifying...</span>
            </>
          ) : (
            'Verify Code'
          )}
        </button>
      </form>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const router = useRouter();
  const { login, completeTwoFactor, error, clearError, twoFactorChallenge } = useAuth();

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

  useEffect(() => {
    if (!inviteToken) return;
    fetch(`/api/invite/${inviteToken}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (json?.data) setInviteData(json.data as InviteData);
      })
      .catch(() => null);
  }, [inviteToken]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    clearError();
    setSubmitting(true);

    try {
      const fingerprint = getDeviceFingerprint();
      const didRequire2FA = await login(email.trim().toLowerCase(), password, fingerprint);
      if (!didRequire2FA) {
        await router.push(returnTo);
      }
      // If 2FA required, twoFactorChallenge is now set — component re-renders to show 2FA screen
    } catch {
      // Error already set in AuthContext
    } finally {
      setSubmitting(false);
    }
  };

  const handleTwoFactorVerify = async (code: string, trustDevice: boolean) => {
    clearError();
    setSubmitting(true);
    try {
      const fingerprint = getDeviceFingerprint();
      const deviceName = getDeviceName();
      await completeTwoFactor(code, trustDevice, fingerprint, deviceName);
      await router.push(returnTo);
    } catch {
      // Error already set in AuthContext
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
          <p className="text-sm text-gray-500 mt-1">
            {twoFactorChallenge ? 'Verify your identity' : 'Sign in to your account'}
          </p>
        </div>

        {/* Invite banner — only on login screen */}
        {!twoFactorChallenge && inviteData && (
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
        {!twoFactorChallenge && router.query.registered === '1' && (
          <div className="mb-4 px-3 py-2.5 bg-green-500/10 border border-green-500/30 rounded-lg">
            <p className="text-sm text-green-400">Account created successfully! Please sign in.</p>
          </div>
        )}

        {/* 2FA Screen */}
        {twoFactorChallenge ? (
          <TwoFactorScreen
            onVerify={handleTwoFactorVerify}
            loading={isBusy}
            error={error}
          />
        ) : (
          /* Login Card */
          <div className="bg-gray-900 border border-gray-700 rounded-2xl p-6 shadow-xl">
            <form onSubmit={(e) => void handleSubmit(e)} noValidate>

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
                  onChange={e => { clearError(); setEmail(e.target.value); }}
                  disabled={isBusy}
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
                  placeholder="you@example.com"
                />
              </div>

              {/* Password */}
              <div className="mb-6">
                <label htmlFor="password" className="block text-xs font-medium text-gray-400 mb-1.5">
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
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
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
        )}

        {/* Footer link — only on login screen */}
        {!twoFactorChallenge && (
          <p className="text-center text-sm text-gray-500 mt-6">
            Don&apos;t have an account?{' '}
            <Link
              href={inviteToken ? `/register?invite=${inviteToken}` : '/register'}
              className="text-teal-400 hover:text-teal-300 transition-colors"
            >
              Create one
            </Link>
          </p>
        )}

      </div>
    </div>
  );
}
