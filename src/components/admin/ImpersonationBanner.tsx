/**
 * ImpersonationBanner
 * Shown at the top of the customer app when a super_admin is impersonating a company.
 * Reads the impersonation token from localStorage (set by admin impersonate flow).
 * Shows company name and an Exit button that clears the session.
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { ShieldAlert, X } from 'lucide-react';

const STORAGE_KEY = 'isaflow_impersonation';

export interface ImpersonationSession {
  token: string;
  company_id: string;
  company_name: string;
  expires_at: string;
}

/**
 * Store an impersonation session in localStorage.
 * Called from the admin UI after receiving the token from the API.
 */
export function setImpersonationSession(session: ImpersonationSession): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

/**
 * Read the current impersonation session if valid (not expired).
 */
export function getImpersonationSession(): ImpersonationSession | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as ImpersonationSession;
    if (!session.token || !session.expires_at) return null;
    if (new Date(session.expires_at) <= new Date()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

/**
 * Clear the impersonation session.
 */
export function clearImpersonationSession(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * ImpersonationBanner component.
 * Mount this in AppLayout or _app.tsx. It self-hides when not impersonating.
 */
export function ImpersonationBanner() {
  const router = useRouter();
  const [session, setSession] = useState<ImpersonationSession | null>(null);

  useEffect(() => {
    const s = getImpersonationSession();
    setSession(s);
  }, []);

  if (!session) return null;

  const handleExit = () => {
    clearImpersonationSession();
    setSession(null);
    // Redirect back to admin panel
    router.push('http://admin.isaflow.co.za/admin/companies');
  };

  const expiresAt = new Date(session.expires_at);
  const minutesLeft = Math.max(
    0,
    Math.round((expiresAt.getTime() - Date.now()) / 60_000)
  );

  return (
    <div className="fixed top-0 inset-x-0 z-50 bg-amber-500 text-amber-950 flex items-center justify-between px-4 py-2 text-sm font-medium shadow-md">
      <div className="flex items-center gap-2">
        <ShieldAlert className="w-4 h-4 flex-shrink-0" />
        <span>
          Admin view: <strong>{session.company_name}</strong>
          <span className="ml-2 opacity-75 text-xs font-normal">
            (expires in {minutesLeft} min)
          </span>
        </span>
      </div>
      <button
        onClick={handleExit}
        className="flex items-center gap-1.5 px-3 py-1 bg-amber-800/20 hover:bg-amber-800/40 rounded-lg text-xs font-semibold transition-colors"
      >
        <X className="w-3.5 h-3.5" />
        Exit Impersonation
      </button>
    </div>
  );
}
