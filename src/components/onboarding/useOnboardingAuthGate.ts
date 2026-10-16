/**
 * The onboarding page's mount-time gate: decides whether this user belongs on
 * the wizard at all, or has already finished (or was invited into a company)
 * and is sent on to /accounting. Moved out of pages/onboarding/index.tsx
 * unchanged, to keep the page under 300 lines.
 */

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { apiFetch, isAuthUnavailableStatus } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

export function useOnboardingAuthGate(isAddNew: boolean) {
  const router = useRouter();
  const [error, setError]             = useState('');
  const [authChecked, setAuthChecked] = useState(false);
  const [authTimeout, setAuthTimeout] = useState(false);
  const redirectingRef = useRef(false);

  // Auth check — fires once on mount only.
  // router is intentionally excluded from deps: it is only used for navigation,
  // not for reading state. Including it caused repeated fires each time Next.js
  // updated the router reference during navigation, creating a redirect loop.
  useEffect(() => {
    let cancelled = false;

    const redirectToAccounting = () => {
      if (redirectingRef.current) return;
      redirectingRef.current = true;
      window.location.replace('/accounting');
    };

    // 10-second escape hatch: if auth check hangs, show the escape link.
    const timeoutId = window.setTimeout(() => {
      if (!cancelled && !authChecked) setAuthTimeout(true);
    }, 10_000);

    apiFetch('/api/auth/me').then(async (r) => {
      if (cancelled || redirectingRef.current) return;
      if (!r.ok) {
        window.clearTimeout(timeoutId);
        if (isAuthUnavailableStatus(r.status)) setAuthTimeout(true); else void router.replace('/login'); // D9: an outage is not a sign-out
        return;
      }
      const body = await r.json();

      // When adding a new company, skip both guards and go straight to the wizard.
      if (isAddNew) {
        window.clearTimeout(timeoutId);
        if (!cancelled) setAuthChecked(true);
        return;
      }

      // Correct field path: body.data.user.onboarding_completed (snake_case, nested).
      // Only bypass when explicitly true — if it's null/undefined (legacy users),
      // fall through to the membership check below.
      if (body.data?.user?.onboarding_completed === true) {
        window.clearTimeout(timeoutId);
        // Await the POST so the Set-Cookie (ff_onboarding_done) is received
        // before the redirect. Without this, middleware.ts:181-186 redirects
        // any /accounting/* request without the cookie back to /onboarding,
        // creating an infinite loop when the cookie is absent (incognito,
        // cookie-clear, cross-domain) even though the DB flag is true.
        const completeRes = await apiFetch('/api/onboarding/complete', { method: 'POST' });
        if (cancelled || redirectingRef.current) return;
        if (!completeRes.ok) {
          log.warn('onboarding/complete POST failed on already-completed check', { status: completeRes.status }, 'onboarding');
          if (!cancelled) { setError('Could not restore your session. Please try again.'); setAuthChecked(true); }
          return;
        }
        redirectToAccounting();
        return;
      }

      // If onboarding_completed === false (admin reset), show the wizard — don't
      // use the membership bypass for explicitly-false flags.
      if (body.data?.user?.onboarding_completed === false) {
        window.clearTimeout(timeoutId);
        if (!cancelled) setAuthChecked(true);
        return;
      }

      // Legacy users: onboarding_completed is null/undefined.
      // Invited users (and users returning after completing the wizard) already
      // have a company membership — auto-complete and redirect.
      try {
        const compRes = await apiFetch('/api/accounting/companies?action=user-companies');
        if (cancelled || redirectingRef.current) return;
        if (compRes.ok) {
          const compBody = (await compRes.json()) as { data?: { items?: unknown[] } };
          const companies = compBody.data?.items ?? [];
          if (Array.isArray(companies) && companies.length > 0) {
            // Await the POST so the Set-Cookie response is received before the
            // redirect. The cookie is required by middleware — without it the
            // next request to /accounting would bounce back to /onboarding.
            const completeRes = await apiFetch('/api/onboarding/complete', { method: 'POST' });
            if (cancelled || redirectingRef.current) return;
            if (!completeRes.ok) {
              log.warn('onboarding/complete POST failed', { status: completeRes.status }, 'onboarding');
              // Stay on wizard with error message rather than blind redirect.
              if (!cancelled) {
                setError('Could not auto-complete onboarding. Please continue manually.');
                setAuthChecked(true);
              }
              window.clearTimeout(timeoutId);
              return;
            }
            window.clearTimeout(timeoutId);
            // Full navigation so the browser sends the freshly-set cookie on the
            // next request — avoids the SPA-navigation cookie race.
            redirectToAccounting();
            return;
          }
        } else log.warn('Could not load the user companies during onboarding', { status: compRes.status }, 'onboarding');
      } catch (err) {
        log.warn('Failed to check user companies during onboarding', { error: err }, 'onboarding');
        // Non-fatal — fall through to show the wizard
      }

      window.clearTimeout(timeoutId);
      if (!cancelled) setAuthChecked(true);
    }).catch((err: unknown) => {
      log.warn('Auth check failed on onboarding page', { error: err }, 'onboarding');
      window.clearTimeout(timeoutId);
      if (!cancelled) setAuthTimeout(true); // D9: unreachable is not signed out
    });

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { authChecked, authTimeout, error, setError };
}
