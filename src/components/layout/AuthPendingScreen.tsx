/**
 * AuthPendingScreen — what ShellSkeleton shows in the content area until the first session check has an answer.
 * Normally a placeholder in the shape of a page (title, a row of cards, a table). During an auth-service outage (D9)
 * it says so instead of signing anyone out: AuthContext keeps retrying every few seconds in the background and the
 * page appears by itself once /api/auth/me answers.
 */

import { useAuth } from '@/contexts/AuthContext';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';

const PULSE = 'rounded-lg bg-slate-200 dark:bg-white/10';

function ContentPlaceholder() {
  return (
    <div className="p-4 lg:p-6">
      <div role="status" aria-label="Loading" className="animate-pulse space-y-6">
        <div className="space-y-2">
          <div className={`h-6 w-48 ${PULSE}`} />
          <div className={`h-4 w-72 max-w-full ${PULSE}`} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[0, 1, 2].map(i => <div key={i} className={`h-20 ${PULSE}`} />)}
        </div>
        <div className="space-y-3">
          {[0, 1, 2, 3, 4, 5].map(i => <div key={i} className={`h-9 ${PULSE}`} />)}
        </div>
        <span className="sr-only">Loading...</span>
      </div>
    </div>
  );
}

export function AuthPendingScreen() {
  // authChecking covers a background retry too, so the button never invites a click that would only
  // join a check already in flight.
  const { authUnavailable, authChecking, refreshUser } = useAuth();

  if (!authUnavailable) return <ContentPlaceholder />;
  return (
    <div className="h-full flex items-center justify-center px-4">
      <div className="text-center max-w-sm">
        <LoadingSpinner size="lg" className="mx-auto mb-4" />
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
      </div>
    </div>
  );
}
