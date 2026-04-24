/**
 * /login — Email + password sign-in page.
 * Supports ?invite=[token] to show an invitation banner.
 * Redirects to /accounting on success; shows 2FA challenge if required.
 *
 * 2FA path: login API returns {requires_2fa, factor_id, pending_token}
 * → local `step` state → TwoFactorScreen → /api/auth/2fa-challenge
 */

import { useState, useEffect, useRef, FormEvent } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Image from 'next/image';
import { Eye, EyeOff, Building2, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

type LoginStep = 'credentials' | 'totp';

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

// ── 2FA Screen ────────────────────────────────────────────────────────────────

function TwoFactorScreen({
  onVerify,
  onCancel,
  loading,
  error,
}: {
  onVerify: (code: string, trustDevice: boolean) => Promise<void>;
  onCancel?: () => void;
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
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl p-6 shadow-xl">
      <div className="flex flex-col items-center mb-6">
        <div className="p-3 bg-teal-500/10 rounded-full mb-3">
          <ShieldCheck className="h-8 w-8 text-teal-400" />
        </div>
        <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Two-Factor Authentication</h2>
        <p className="text-sm text-slate-500 dark:text-gray-400 mt-1 text-center">
          Enter the 6-digit code from your authenticator app, or a backup code.
        </p>
      </div>

      <form onSubmit={(e) => void handleSubmit(e)} noValidate>
        <div className="mb-4">
          <label htmlFor="code" className="block text-xs font-medium text-slate-500 dark:text-gray-400 mb-1.5">
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
            className="w-full bg-slate-50 dark:bg-gray-800 border border-slate-300 dark:border-gray-600 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition text-center tracking-widest font-mono text-lg"
          />
        </div>

        <div className="mb-6 flex items-center gap-2">
          <input
            id="trust-device"
            type="checkbox"
            checked={trustDevice}
            onChange={e => setTrustDevice(e.target.checked)}
            className="rounded border-slate-300 dark:border-gray-600 bg-slate-100 dark:bg-gray-800 text-teal-500 focus:ring-teal-500"
          />
          <label htmlFor="trust-device" className="text-sm text-slate-500 dark:text-gray-400 cursor-pointer">
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

        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="mt-3 w-full text-sm text-slate-500 dark:text-gray-400 hover:text-slate-700 dark:hover:text-gray-200 transition-colors disabled:opacity-50"
          >
            Back to sign in
          </button>
        )}
      </form>
    </div>
  );
}

// ── Safe Redirect ─────────────────────────────────────────────────────────────

function isSafeRedirect(url: string): boolean {
  return url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\');
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function LoginPage() {
  const router = useRouter();
  const { error, clearError, refreshUser } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [inviteData, setInviteData] = useState<InviteData | null>(null);

  // GoTrue TOTP step state
  const [step, setStep] = useState<LoginStep>('credentials');
  const [pendingFactor, setPendingFactor] = useState<{ factor_id: string; pending_token: string } | null>(null);
  const [totpError, setTotpError] = useState<string | null>(null);

  const inviteToken =
    typeof router.query.invite === 'string' ? router.query.invite : null;

  const isAdminHost =
    typeof window !== 'undefined' && window.location.hostname === 'admin.isaflow.co.za';
  const defaultRedirect = isAdminHost ? '/' : '/accounting';

  const returnTo =
    typeof router.query.returnTo === 'string' && isSafeRedirect(router.query.returnTo)
      ? router.query.returnTo
      : defaultRedirect;

  useEffect(() => {
    if (!inviteToken) return;
    fetch(`/api/invite/${inviteToken}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (json?.data) setInviteData(json.data as InviteData);
      })
      .catch(() => null);
  }, [inviteToken]);

  // Post-auth redirect: send users with no companies to /onboarding
  const postLoginRedirect = async (): Promise<string> => {
    if (isAdminHost) return returnTo;
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
      // Non-fatal — fall through to the configured returnTo
    }
    return returnTo;
  };

  // Credential submit — direct fetch so we can intercept requires_2fa before AuthContext
  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    clearError();
    setTotpError(null);
    setSubmitting(true);

    try {
      const fingerprint = getDeviceFingerprint();
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), password, deviceFingerprint: fingerprint }),
        credentials: 'include',
      });

      const json = await res.json() as {
        success: boolean;
        data?: {
          requires_2fa?: boolean;
          factor_id?: string;
          user?: unknown;
        };
        error?: { message: string };
        message?: string;
      };

      if (!res.ok || !json.success) {
        // Surface error — setError is not exposed from AuthContext, so throw to catch block
        throw new Error(json.error?.message ?? json.message ?? 'Login failed');
      }

      // GoTrue 2FA gate — show TOTP step.
      // pending_token is now held in an HttpOnly cookie set by /api/auth/login;
      // the 2fa-challenge endpoint reads it from cookies (pentest H6).
      if (json.data?.requires_2fa) {
        setPendingFactor({
          factor_id: json.data.factor_id as string,
          pending_token: '',
        });
        setStep('totp');
        return;
      }

      // No 2FA — sync AuthContext with the new session cookie before
      // navigating so CompanyProvider can load companies on first paint
      // (otherwise isAuthenticated stays false until the next refresh).
      await refreshUser();
      await router.push(await postLoginRedirect());
    } catch (err) {
      setTotpError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  };

  // GoTrue TOTP verify — POST to /api/auth/2fa-challenge
  const handleTotpVerify = async (code: string, _trustDevice: boolean) => {
    if (!pendingFactor) return;
    setTotpError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/2fa-challenge', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include', // send sb-pending-mfa cookie
        body: JSON.stringify({
          factor_id: pendingFactor.factor_id,
          code,
        }),
      });
      const json = await res.json() as {
        success: boolean;
        data?: { user?: { id: string }; activeCompanyId?: string | null };
        error?: { message: string };
      };
      if (!json.success) {
        setTotpError(json.error?.message ?? 'Invalid code');
        return;
      }
      // Sync AuthContext before navigating — same reason as the no-MFA path.
      await refreshUser();
      // Navigate using same postLoginRedirect logic as the no-MFA path
      await router.push(await postLoginRedirect());
    } catch {
      setTotpError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const cancelTotp = () => {
    setStep('credentials');
    setPendingFactor(null);
    setTotpError(null);
  };

  const isBusy = submitting;
  const showTotpStep = step === 'totp';

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-gray-950 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <Image src="/logo.png" alt="ISAFlow" width={160} height={64} className="h-16 w-auto dark:brightness-0 dark:invert mb-4" priority />
          <p className="text-sm text-slate-600 dark:text-slate-300 mt-1">
            {showTotpStep ? 'Verify your identity' : 'Sign in to your account'}
          </p>
        </div>

        {/* Invite banner — only on credentials screen */}
        {!showTotpStep && inviteData && (
          <div className="mb-4 px-4 py-3 bg-teal-900/30 border border-teal-700/50 rounded-lg flex items-start gap-3">
            <Building2 className="h-4 w-4 text-teal-400 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-teal-300">
              You&apos;ve been invited to join{' '}
              <span className="font-medium text-slate-900 dark:text-white">{inviteData.companyName}</span>
              {' '}as <span className="font-medium">{inviteData.role}</span>.
              Sign in to accept.
            </p>
          </div>
        )}

        {/* Registration success banner */}
        {!showTotpStep && router.query.registered === '1' && (
          <div className="mb-4 px-3 py-2.5 bg-green-500/10 border border-green-500/30 rounded-lg">
            <p className="text-sm text-green-400">Account created successfully! Please sign in.</p>
          </div>
        )}

        {/* GoTrue TOTP step */}
        {showTotpStep && (
          <TwoFactorScreen
            onVerify={handleTotpVerify}
            onCancel={cancelTotp}
            loading={isBusy}
            error={totpError}
          />
        )}

        {/* Credentials card */}
        {!showTotpStep && (
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl p-6 shadow-xl">
            <form onSubmit={(e) => void handleSubmit(e)} noValidate>

              {/* Email */}
              <div className="mb-4">
                <label htmlFor="email" className="block text-xs font-medium text-slate-500 dark:text-gray-400 mb-1.5">
                  Email address
                </label>
                <input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={e => { clearError(); setTotpError(null); setEmail(e.target.value); }}
                  disabled={isBusy}
                  className="w-full bg-slate-50 dark:bg-gray-800 border border-slate-300 dark:border-gray-600 rounded-lg px-3 py-2.5 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
                  placeholder="you@example.com"
                />
              </div>

              {/* Password */}
              <div className="mb-6">
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="password" className="block text-xs font-medium text-slate-500 dark:text-gray-400">
                    Password
                  </label>
                  <Link
                    href="/forgot-password"
                    className="text-xs text-teal-400 hover:text-teal-300 transition-colors"
                    tabIndex={-1}
                  >
                    Forgot password?
                  </Link>
                </div>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={e => { clearError(); setTotpError(null); setPassword(e.target.value); }}
                    disabled={isBusy}
                    className="w-full bg-slate-50 dark:bg-gray-800 border border-slate-300 dark:border-gray-600 rounded-lg px-3 py-2.5 pr-10 text-sm text-slate-900 dark:text-white placeholder-slate-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-transparent disabled:opacity-50 transition"
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

              {/* Error message (AuthContext error or local fetch error) */}
              {(error ?? totpError) && (
                <div className="mb-4 px-3 py-2.5 bg-red-500/10 border border-red-500/30 rounded-lg">
                  <p className="text-sm text-red-400">{error ?? totpError}</p>
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

        {/* Footer link — only on credentials screen. Pre-launch, public
            signups land on the waitlist form; invite flows keep the real
            "create account" wording. */}
        {!showTotpStep && (
          <p className="text-center text-sm text-slate-500 dark:text-gray-500 mt-6">
            Don&apos;t have an account?{' '}
            <Link
              href={inviteToken ? `/register?invite=${inviteToken}` : '/register'}
              className="text-teal-400 hover:text-teal-300 transition-colors"
            >
              {inviteToken ? 'Create one' : 'Join the waitlist'}
            </Link>
          </p>
        )}

      </div>
    </div>
  );
}
