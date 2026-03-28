/**
 * Offline fallback page — shown when the user is offline and the requested page is not cached.
 * Does not use AppLayout since the user may not be authenticated.
 */

export default function OfflinePage() {
  return (
    <div className="min-h-screen bg-slate-900 flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        {/* Logo */}
        <div className="mb-8 flex justify-center">
          <div className="w-16 h-16 bg-teal-600 rounded-2xl flex items-center justify-center">
            <svg
              className="w-8 h-8 text-white"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
              />
            </svg>
          </div>
        </div>

        <h1 className="text-2xl font-bold text-white mb-2">IsaFlow</h1>

        {/* Offline indicator */}
        <div className="mb-6 inline-flex items-center gap-2 px-3 py-1.5 rounded-full bg-amber-500/10 border border-amber-500/20">
          <div className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          <span className="text-sm text-amber-400 font-medium">You&apos;re offline</span>
        </div>

        <p className="text-slate-400 text-sm leading-relaxed mb-8">
          Some features are available offline. Please check your connection to access all features.
        </p>

        <button
          onClick={() => window.location.reload()}
          className="inline-flex items-center gap-2 px-6 py-2.5 bg-teal-600 hover:bg-teal-500 text-white text-sm font-medium rounded-lg transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}>
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          Retry connection
        </button>
      </div>
    </div>
  );
}
