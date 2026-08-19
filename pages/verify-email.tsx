/**
 * /verify-email — lands here from the signup confirmation email.
 *
 * The token arrives in the URL fragment (`#token=...`), never the query string,
 * so it is not sent to the server on page load, not logged, not placed in a
 * Referer header, and not visible to the analytics tracker. The page reads it
 * client-side and POSTs it to /api/auth/verify-email, which is what actually
 * provisions the tenant.
 *
 * The fragment is deliberately left in the address bar. Clearing it needs a
 * history.replaceState that Next undoes — its own post-hydration replaceState
 * carries the full asPath, hash included, and lands after any effect here
 * (confirmed against the dev server; router.replace and a deferred call both
 * failed too). It buys nothing anyway: the token is single-use and has already
 * been consumed by the time this page finishes rendering.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, XCircle } from 'lucide-react';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { WaitlistPageShell } from '@/components/landing/WaitlistPageShell';
import { AUTH_CARD_CLASS, AUTH_CARD_ACCENT_CLASS } from '@/components/auth/authCardStyles';

type State = 'verifying' | 'done' | 'failed';

export default function VerifyEmailPage() {
  const [state, setState] = useState<State>('verifying');
  const [error, setError] = useState('');
  // React 18 StrictMode double-invokes effects in dev. The token is single-use,
  // so a second POST would consume nothing and render a spurious failure.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const token = new URLSearchParams(window.location.hash.slice(1)).get('token');
    if (!token) {
      setError('This confirmation link is missing its token. Please use the link from your email.');
      setState('failed');
      return;
    }

    void (async () => {
      try {
        const res = await fetch('/api/auth/verify-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });
        const json = (await res.json()) as {
          success: boolean;
          error?: { message?: string };
        };
        if (!res.ok || !json.success) {
          setError(json.error?.message ?? 'We could not confirm your email.');
          setState('failed');
          return;
        }
        setState('done');
      } catch {
        setError('Could not reach the server. Please check your connection and try again.');
        setState('failed');
      }
    })();
  }, []);

  return (
    <WaitlistPageShell>
      <div className="mx-auto w-full max-w-md lg:-mt-10">
        <div className={AUTH_CARD_CLASS}>
          <div className={AUTH_CARD_ACCENT_CLASS} />

          {state === 'verifying' && (
            <div className="flex flex-col items-center gap-3 py-6 text-center">
              <LoadingSpinner size="sm" />
              <p className="text-sm text-slate-600">Confirming your email…</p>
            </div>
          )}

          {state === 'done' && (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <CheckCircle2 className="h-10 w-10 text-teal-600" />
              <h2 className="text-xl font-bold text-slate-900">Email confirmed</h2>
              <p className="text-sm text-slate-600">
                Your account is active and your 14-day trial has started. Sign in to get going.
              </p>
              <Link
                href="/login"
                className="mt-2 w-full rounded-lg bg-teal-600 px-4 py-3 text-center text-sm font-semibold text-white shadow-lg shadow-teal-600/25 transition hover:bg-teal-700"
              >
                Sign in
              </Link>
            </div>
          )}

          {state === 'failed' && (
            <div className="flex flex-col items-center gap-3 py-4 text-center">
              <XCircle className="h-10 w-10 text-red-500" />
              <h2 className="text-xl font-bold text-slate-900">Could not confirm</h2>
              <p role="alert" className="text-sm text-slate-600">{error}</p>
              <Link
                href="/register"
                className="mt-2 w-full rounded-lg border border-slate-300 px-4 py-3 text-center text-sm font-semibold text-slate-700 transition hover:border-teal-400"
              >
                Sign up again
              </Link>
            </div>
          )}
        </div>
      </div>
    </WaitlistPageShell>
  );
}
