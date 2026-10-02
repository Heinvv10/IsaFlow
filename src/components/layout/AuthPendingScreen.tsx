/**
 * AuthPendingScreen — what AppLayout shows until the first session check has
 * an answer. Normally a spinner. During an auth-service outage (D9) it says so,
 * because the session is not lost: AuthContext keeps retrying every few
 * seconds in the background and the page appears by itself once it answers.
 */

import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

export function AuthPendingScreen() {
  const { authUnavailable, refreshUser } = useAuth();
  const [retrying, setRetrying] = useState(false);

  const retry = async () => {
    setRetrying(true);
    try {
      await refreshUser();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-gray-950 px-4">
      <div className="text-center max-w-sm">
        <LoadingSpinner size="lg" className="mx-auto mb-4" />
        {authUnavailable ? (
          <div role="alert" className="space-y-3">
            <p className="text-slate-700 dark:text-gray-200 text-sm">
              {/* Nothing more: the session cookie is HttpOnly and unverified, so the client cannot vouch for it. */}
              IsaFlow can&apos;t reach the sign-in service right now. We&apos;ll keep trying.
            </p>
            <button
              type="button"
              onClick={() => { void retry(); }}
              disabled={retrying}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-teal-600 hover:bg-teal-500 text-white disabled:opacity-50"
            >
              Retry
            </button>
          </div>
        ) : (
          <p className="text-slate-500 dark:text-gray-400 text-sm">Loading...</p>
        )}
      </div>
    </div>
  );
}
