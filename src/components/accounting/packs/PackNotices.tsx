export function PackNotices({ downloadError, loadError, rateLimited }: {
  downloadError: string | null;
  loadError: string;
  rateLimited: { seconds: number | null } | null;
}) {
  return (
    <>
      {downloadError && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400"
        >
          {/* `whitespace-pre-line`: the integrity gate reports every
              problem it found, one per line. Collapsed onto one line a
              three-problem refusal is unreadable, and the reader needs
              all three — a pack that has drifted has usually drifted in
              more than one place. */}
          <p className="font-medium">This pack could not be downloaded.</p>
          <p className="mt-1 whitespace-pre-line">{downloadError}</p>
        </div>
      )}
      {loadError && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400"
        >
          {loadError}
        </div>
      )}
      {rateLimited && (
        <div
          role="status"
          className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-400"
        >
          Too many report requests. {rateLimited.seconds === null
            ? 'Please try again in a moment.'
            : `Please try again in ${rateLimited.seconds} seconds.`}
        </div>
      )}
    </>
  );
}
