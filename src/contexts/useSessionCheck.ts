// src/contexts/useSessionCheck.ts
import { useCallback, useRef, useState } from 'react';
import { isAuthUnavailableStatus, AUTH_RETRY_AFTER_SECS } from '@/lib/auth/authUpstream';
import { refreshSession } from '@/lib/apiFetch';
import { log } from '@/lib/logger';

type RawUser = Record<string, unknown>;

/** A /api/auth/me that has not answered by then is abandoned as an outage (D9): Retry comes back and the next retry is armed. */
export const AUTH_CHECK_TIMEOUT_MS = 10_000;

/** False only when the server says this browser holds no refresh cookie to renew from. */
async function canRenew(res: Response): Promise<boolean> {
  try {
    const body = (await res.clone().json()) as { error?: { renewable?: unknown } } | null;
    return body?.error?.renewable !== false;
  } catch {
    return true; // no readable answer: let the refresh itself decide
  }
}

interface RetryState {
  active: boolean;
  settled: boolean;
  timer?: ReturnType<typeof setTimeout>;
  inFlight?: Promise<void>;
}

/**
 * The /api/auth/me check behind AuthProvider (D9). An outage (5xx/408/429 or
 * unreachable) is not a sign-out: the known user is kept (AdminLayout redirects
 * on a null user), a FIRST check stays pending and retries every
 * AUTH_RETRY_AFTER_SECS, and a settled session retries only on the provider's
 * focus/interval re-checks, so an outage is not polled harder. A check asked
 * for while one is in flight joins it: Retry, focus and the timer never stack
 * requests. `authChecking` is true while a check is in flight. A 401 first tries
 * the refresh cookie, and a refused renewal is what clears the user.
 */
export function useSessionCheck(
  applyUser: (raw: RawUser | null) => void,
  setLoading: (loading: boolean) => void,
) {
  const [authUnavailable, setAuthUnavailable] = useState(false);
  const [authChecking, setAuthChecking] = useState(false);
  const retry = useRef<RetryState>({ active: true, settled: false });

  const checkAuth = useCallback(function check(): Promise<void> {
    const state = retry.current;
    if (state.inFlight) return state.inFlight;
    clearTimeout(state.timer);
    setAuthChecking(true);
    const run = async () => {
      let unavailable = false;
      // A plain timer, not AbortSignal.timeout: the abort then follows the page's own clock.
      const controller = new AbortController();
      const abandon = setTimeout(() => controller.abort(), AUTH_CHECK_TIMEOUT_MS);
      try {
        const readMe = () => fetch('/api/auth/me', { credentials: 'include', signal: controller.signal });
        let res = await readMe();
        // The access cookie lives an hour, the refresh cookie up to 30 days: a 401 is
        // only a sign-out once the renewal has been refused too.
        const renewal = res.status === 401 && (await canRenew(res)) ? await refreshSession() : null;
        if (renewal === 'refreshed') res = await readMe();
        if (renewal === 'unavailable') {
          unavailable = true;
        } else if (res.ok) {
          const data = await res.json();
          // Support both { data: { user } } and { data: user } shapes
          applyUser(data.data?.user ?? data.data ?? data.user ?? null);
        } else if (isAuthUnavailableStatus(res.status)) {
          unavailable = true;
        } else {
          applyUser(null);
        }
      } catch (err) {
        unavailable = true;
        log.error('Failed to check auth session', { error: err }, 'auth-context');
      } finally {
        clearTimeout(abandon);
      }
      setAuthUnavailable(unavailable);
      if (!unavailable) {
        state.settled = true;
        setLoading(false);
      } else if (state.active && !state.settled) {
        state.timer = setTimeout(() => { void check(); }, AUTH_RETRY_AFTER_SECS * 1000);
      }
    };
    state.inFlight = run().finally(() => {
      state.inFlight = undefined;
      setAuthChecking(false);
    });
    return state.inFlight;
  }, [applyUser, setLoading]);

  /** Arms the retry timer for a mounted provider; the returned cleanup cancels a pending retry. */
  const startRetries = useCallback(() => {
    const state = retry.current;
    state.active = true;
    return () => {
      state.active = false;
      clearTimeout(state.timer);
    };
  }, []);

  return { checkAuth, authUnavailable, authChecking, startRetries };
}
