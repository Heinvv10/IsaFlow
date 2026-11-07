// src/components/auth/useResumeRenewedSession.ts
import { useEffect } from 'react';

const LAST_RESUME_KEY = 'isaflow_login_resumed_at';
/** Long enough that a page still refusing the renewed session stops on the form instead of looping. */
const RESUME_COOLDOWN_MS = 60_000;

/**
 * A page that checks the session on the server (`getServerSideProps`) sends a browser
 * holding only the refresh cookie to /login?returnTo=..., and AuthProvider renews the
 * session there. Go back to the page rather than ask for a password nobody needs.
 */
export function useResumeRenewedSession(isAuthenticated: boolean, returnTo: string | null): void {
  useEffect(() => {
    if (!isAuthenticated || !returnTo) return;
    try {
      const last = Number(sessionStorage.getItem(LAST_RESUME_KEY));
      if (Date.now() - last < RESUME_COOLDOWN_MS) return;
      sessionStorage.setItem(LAST_RESUME_KEY, String(Date.now()));
    } catch {
      return; // storage blocked: the loop guard cannot work, so stay on the form
    }
    window.location.replace(returnTo);
  }, [isAuthenticated, returnTo]);
}
