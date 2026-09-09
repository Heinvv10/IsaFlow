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
import { Eye, EyeOff, Building2, ShieldCheck, Lock, Mail } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { clearTenantClientState } from '@/lib/auth/clearTenantClientState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { LoginBrandPanel } from '@/components/auth/LoginBrandPanel';

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

// ── Lockout helpers ───────────────────────────────────────────────────────────

// Pentest PR-3 / M24: /api/auth/login and /api/auth/2fa-challenge return 423
// ACCOUNT_LOCKED after 10 consecutive failures per (email, ip). The server sets
// Retry-After; we turn it into a live countdown so the user isn't left guessing.
function formatLockoutRemaining(seconds: number): string {
  if (seconds >= 120) return `${Math.ceil(seconds / 60)} minutes`;
  if (seconds >= 60) return '1 minute';
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

function LockoutBanner({ secondsRemaining }: { secondsRemaining: number }) {
  return (
    <div className="mb-4 px-4 py-3 bg-amber-500/10 border border-amber-500/40 rounded-lg flex items-start gap-3">
      <Lock className="h-5 w-5 text-amber-400 mt-0.5 flex-shrink-0" />
      <div className="flex-1">
        <p className="text-sm font-medium text-amber-300">Sign-in temporarily locked</p>
        <p className="text-sm text-amber-200/80 mt-0.5">
          Too many failed attempts from this device. Please try again in {formatLockoutRemaining(secondsRemaining)}.
        </p>
      </div>
    </div>
  );
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

        {/* TODO(PRD-10-followup): trustDevice flag is collected but never sent to
            the server. This is "skip-2FA-on-this-device" — a different concept from
            PRD-10's "Keep me signed in" (session length). Wire up with a device-
            fingerprint table in a separate PRD covering MFA UX. */}
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
  const { error, clearError, isAuthenticated, loading: authLoading } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  // PRD-10 Layer 1: defaults to true (Sage Cloud parity).
  const [rememberMe, setRememberMe] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [inviteData, setInviteData] = useState<InviteData | null>(null);

  // GoTrue TOTP step state
  const [step, setStep] = useState<LoginStep>('credentials');
  const [pendingFactor, setPendingFactor] = useState<{ factor_id: string; pending_token: string } | null>(null);
  const [totpError, setTotpError] = useState<string | null>(null);

  // Account lockout state — populated when the API returns 423 ACCOUNT_LOCKED.
  // `expiresAt` is absolute ms; the countdown re-renders once per second.
  const [lockoutExpiresAt, setLockoutExpiresAt] = useState<number | null>(null);
  const [lockoutSecondsRemaining, setLockoutSecondsRemaining] = useState(0);

  // Cross-tenant safety: when an UNauthenticated visitor lands on /login
  // (regardless of how they got here — explicit logout, session-expired
  // bounce, idle timeout, or typed URL), wipe per-tenant client state so the
  // next sign-in cannot inherit the previous user's active company. Without
  // this, paths that redirect to /login with `window.location.href`
  // (apiFetch 401 refresh-fail, idle bounce) leave isaflow_active_company in
  // localStorage and the next user briefly sees the prior tenant's name in
  // the header. Gated on !isAuthenticated so a logged-in user who hits this
  // page via the back button doesn't get their own active tenant wiped.
  useEffect(() => {
    if (authLoading || isAuthenticated) return;
    clearTenantClientState();
  }, [authLoading, isAuthenticated]);

  useEffect(() => {
    if (lockoutExpiresAt === null) {
      setLockoutSecondsRemaining(0);
      return;
    }
    const tick = () => {
      const remaining = Math.max(0, Math.ceil((lockoutExpiresAt - Date.now()) / 1000));
      setLockoutSecondsRemaining(remaining);
      if (remaining === 0) setLockoutExpiresAt(null);
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [lockoutExpiresAt]);

  const isLocked = lockoutExpiresAt !== null && lockoutSecondsRemaining > 0;

  const inviteToken =
    typeof router.query.invite === 'string' ? router.query.invite : null;
  // Forwarded from /invite/<token>?signup=1, itself set only by
  // /accept-invite's WRONG_INVITE_FLOW verdict. Keeps "Create one" out of the
  // /register -> /accept-invite -> /invite loop for tokens that flow can never
  // accept, without changing routing for any other invitation.
  const wrongFlowSuffix = router.query.signup === '1' ? '&signup=1' : '';

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

  // Post-auth redirect. The server resolver decides the default landing
  // (onboarding / firm /bureau / direct /home); an explicit deep-link
  // returnTo still wins, and no-companies always forces onboarding.
  const postLoginRedirect = async (): Promise<string> => {
    if (isAdminHost) return returnTo;
    try {
      const res = await fetch('/api/auth/landing', { credentials: 'include' });
      if (res.ok) {
        const body = (await res.json()) as { data?: { defaultTarget?: string } };
        const target = body.data?.defaultTarget;
        if (target === '/onboarding') return '/onboarding';
        if (returnTo && returnTo !== defaultRedirect) return returnTo;
        if (target) return target;
      }
    } catch {
      // Non-fatal — fall through to the configured returnTo.
      // On a transient /api/auth/landing failure the user lands on the default
      // returnTo (/accounting) rather than their resolved target (firm /bureau,
      // direct /home); acceptable since their data is still reachable and the
      // next login resolves correctly.
    }
    return returnTo;
  };

  // Credential submit — direct fetch so we can intercept requires_2fa before AuthContext
  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const submittedEmail = String(formData.get('email') ?? '').trim().toLowerCase();
    const submittedPassword = String(formData.get('password') ?? '');

    if (!submittedEmail || !submittedPassword) return;

    setEmail(submittedEmail);
    setPassword(submittedPassword);
    clearError();
    setTotpError(null);
    setSubmitting(true);

    try {
      const fingerprint = getDeviceFingerprint();
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: submittedEmail, password: submittedPassword, rememberMe, deviceFingerprint: fingerprint }),
        credentials: 'include',
      });

      if (res.status === 423) {
        const retryAfter = Number(res.headers.get('Retry-After') ?? '1800');
        setLockoutExpiresAt(Date.now() + retryAfter * 1000);
        return;
      }
      // Non-423 means this (email, ip) is not locked — clear any stale banner
      // from a prior attempt that may have been against a different account.
      setLockoutExpiresAt(null);

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

      // No 2FA — full-page navigate to the authenticated shell. We use
      // window.location.assign rather than router.push so every provider
      // (AuthContext, CompanyContext) re-mounts against the new session
      // cookies. A soft nav would keep the previous user's CompanyContext
      // state (activeCompany hydrated from localStorage at the /login mount)
      // alive until the async user-companies refetch returned — long enough
      // for the dashboard header to flash the wrong tenant's name.
      const target = await postLoginRedirect();
      window.location.assign(target);
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

      if (res.status === 423) {
        const retryAfter = Number(res.headers.get('Retry-After') ?? '1800');
        setLockoutExpiresAt(Date.now() + retryAfter * 1000);
        // Drop back to the credentials screen so the lockout banner replaces
        // the TOTP form — leaving the 2FA screen visible would be misleading.
        setStep('credentials');
        setPendingFactor(null);
        setTotpError(null);
        return;
      }
      setLockoutExpiresAt(null);

      const json = await res.json() as {
        success: boolean;
        data?: { user?: { id: string }; activeCompanyId?: string | null };
        error?: { message: string };
      };
      if (!json.success) {
        setTotpError(json.error?.message ?? 'Invalid code');
        return;
      }
      // Full-page reload to drop any provider state from the /login render —
      // see the no-MFA path for the rationale.
      const target = await postLoginRedirect();
      window.location.assign(target);
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
  // While locked, suppress any stale credential error so the amber lockout
  // banner is the only thing the user sees.
  const visibleError = isLocked ? null : (error ?? totpError);

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
      <div className="absolute inset-0 z-[1] bg-[linear-gradient(90deg,rgba(3,12,27,0.42)_0%,rgba(3,12,27,0.16)_44%,rgba(3,12,27,0)_100%)]" />
      <div className="absolute inset-0 z-[1] bg-[linear-gradient(180deg,rgba(2,8,23,0.22)_0%,rgba(2,8,23,0)_45%,rgba(2,8,23,0.44)_100%)]" />

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

          <div className="hidden items-center gap-8 lg:flex">
            {['Features', 'Pricing', 'Testimonials', 'FAQ'].map((item) => (
              <Link
                key={item}
                href={`/#${item.toLowerCase()}`}
                className="text-sm font-medium text-white/70 transition-colors hover:text-white"
              >
                {item}
              </Link>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <Link
              href="/login"
              className="hidden px-3 py-2 text-sm font-medium text-white/70 transition-colors hover:text-white sm:inline-flex"
            >
              Sign In
            </Link>
            <Link
              href="/register"
              className="inline-flex items-center justify-center rounded-lg bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-teal-950/30 transition-colors hover:bg-teal-500"
            >
              Start Free Trial
            </Link>
          </div>
        </div>
      </nav>

      <main className="relative z-10 mx-auto grid min-h-[calc(100vh-4rem)] max-w-6xl items-center gap-8 px-4 py-8 sm:px-6 lg:min-h-[calc(100vh-5rem)] lg:grid-cols-[minmax(0,1.08fr)_minmax(380px,440px)] lg:gap-10 lg:px-8 lg:py-10">
        <LoginBrandPanel />

        <div className="mx-auto w-full max-w-md lg:-mt-10">

        <div className="mb-5 text-center text-white lg:text-left">
          <h2 className="text-2xl font-bold tracking-normal">
            {showTotpStep ? 'Verify your identity' : 'Welcome back'}
          </h2>
          <p className="mt-1 text-sm text-white/70">
            {showTotpStep ? 'Complete two-factor authentication' : 'Sign in to your ISAFlow account'}
          </p>
        </div>

        {/* Invite banner — only on credentials screen */}
        {!showTotpStep && inviteData && (
            <div className="mb-4 flex items-start gap-3 rounded-lg border border-teal-200/50 bg-white/95 px-4 py-3 shadow-xl backdrop-blur">
            <Building2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-teal-600" />
            <p className="text-sm text-slate-700">
              You&apos;ve been invited to join{' '}
              <span className="font-medium text-slate-950">{inviteData.companyName}</span>
              {' '}as <span className="font-medium">{inviteData.role}</span>.
              Sign in to accept.
            </p>
          </div>
        )}

        {/* Registration success banner */}
        {!showTotpStep && router.query.registered === '1' && (
          <div className="mb-4 rounded-lg border border-green-500/30 bg-green-50/95 px-3 py-2.5 shadow-xl backdrop-blur">
            <p className="text-sm text-green-700">Account created successfully! Please sign in.</p>
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
          <div className="relative overflow-hidden rounded-2xl border border-white/70 bg-[linear-gradient(180deg,rgba(255,255,255,0.92),rgba(248,250,252,0.86))] p-6 shadow-[0_24px_70px_rgba(2,8,23,0.34)] backdrop-blur-2xl sm:p-8">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-teal-300/80 via-teal-500 to-cyan-300/70" />
            <form onSubmit={(e) => void handleSubmit(e)} noValidate>

              {/* Email */}
              <div className="mb-4">
                <label htmlFor="email" className="mb-1.5 block text-xs font-semibold text-slate-700">
                  Email address
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
                    onChange={e => { clearError(); setTotpError(null); setEmail(e.target.value); }}
                    disabled={isBusy}
                    className="w-full rounded-lg border border-slate-300 !bg-white/95 px-10 py-3.5 text-sm !text-slate-950 shadow-sm shadow-slate-950/5 placeholder-slate-400 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50"
                    placeholder="you@example.com"
                  />
                </div>
              </div>

              {/* Password */}
              <div className="mb-5">
                <div className="flex items-center justify-between mb-1.5">
                  <label htmlFor="password" className="block text-xs font-semibold text-slate-700">
                    Password
                  </label>
                  <Link
                    href="/forgot-password"
                    className="text-xs font-medium text-teal-700 transition-colors hover:text-teal-600"
                    tabIndex={-1}
                  >
                    Forgot password?
                  </Link>
                </div>
                <div className="relative">
                  <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={e => { clearError(); setTotpError(null); setPassword(e.target.value); }}
                    disabled={isBusy}
                    className="w-full rounded-lg border border-slate-300 !bg-white/95 py-3.5 pl-10 pr-11 text-sm !text-slate-950 shadow-sm shadow-slate-950/5 placeholder-slate-400 transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-teal-500 disabled:opacity-50"
                    placeholder="Enter your password"
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowPassword(v => !v)}
                    className="absolute inset-y-0 right-0 flex items-center px-3 text-slate-500 transition-colors hover:text-slate-800"
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* PRD-10 Layer 1: Keep me signed in — defaults checked. */}
              <div className="mb-5 flex items-center">
                <input
                  id="rememberMe"
                  type="checkbox"
                  checked={rememberMe}
                  onChange={e => setRememberMe(e.target.checked)}
                  disabled={isBusy}
                  className="h-4 w-4 rounded border-slate-300 bg-white text-teal-600 focus:ring-teal-500 focus:ring-offset-0"
                />
                <label htmlFor="rememberMe" className="ml-2 select-none text-sm text-slate-600">
                  Keep me signed in
                </label>
              </div>

              {/* Lockout banner trumps the credential error */}
              {isLocked && <LockoutBanner secondsRemaining={lockoutSecondsRemaining} />}

              {/* Error message (AuthContext error or local fetch error) */}
              {visibleError && (
                <div className="mb-4 rounded-lg border border-red-500/30 bg-red-50 px-3 py-2.5">
                  <p className="text-sm text-red-600">{visibleError}</p>
                </div>
              )}

              {/* Submit — kept enabled during lockout so the user can try a
                  different email without waiting. The server still enforces
                  the lock on the locked (email, ip) pair. */}
              <button
                type="submit"
                disabled={isBusy}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-teal-700 to-teal-600 px-4 py-3.5 text-sm font-semibold text-white shadow-lg shadow-teal-950/25 transition hover:from-teal-600 hover:to-teal-500 disabled:cursor-not-allowed disabled:from-teal-900/70 disabled:to-teal-800/70"
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

              <div className="mt-5 flex items-center justify-center gap-2 border-t border-slate-200/80 pt-4 text-xs font-medium text-slate-500">
                <ShieldCheck className="h-4 w-4 text-teal-600" />
                <span>Secure sign-in with two-factor authentication support</span>
              </div>
            </form>
          </div>
        )}

        {/* Footer link — only on credentials screen. Pre-launch, public
            signups land on the waitlist form; invite flows keep the real
            "create account" wording. */}
        {!showTotpStep && (
          <p className="mt-6 text-center text-sm text-white/75">
            Don&apos;t have an account?{' '}
            <Link
              href={inviteToken ? `/register?invite=${inviteToken}${wrongFlowSuffix}` : '/register'}
              className="font-semibold text-teal-100 transition-colors hover:text-white"
            >
              {inviteToken ? 'Create one' : 'Start your free trial'}
            </Link>
          </p>
        )}

        </div>
      </main>
    </div>
  );
}
