/**
 * AuthPendingScreen — what ShellSkeleton shows in the content area until the first session check has an answer.
 * Normally a spinner. During an auth-service outage (D9) it says so instead of signing anyone out: AuthContext keeps
 * retrying every few seconds in the background and the page appears by itself once /api/auth/me answers.
 */

import { useAuth } from '@/contexts/AuthContext';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

export function AuthPendingScreen() {
  // authChecking covers a background retry too, so the button never invites a click that would only
  // join a check already in flight.
  const { authUnavailable, authChecking, refreshUser } = useAuth();

  return (
    <div className="h-full flex items-center justify-center px-4">
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
              onClick={() => { void refreshUser(); }}
              disabled={authChecking}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-brand-600 hover:bg-brand-700 text-white disabled:opacity-50"
            >
              {authChecking ? 'Checking…' : 'Retry'}
            </button>
          </div>
        ) : (
          <p className="text-slate-500 dark:text-gray-400 text-sm">Loading...</p>
        )}
      </div>
    </div>
  );
}
