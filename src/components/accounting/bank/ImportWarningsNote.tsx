/**
 * The import's own problems for one file — a failed auto-post ("… still
 * unposted"), a transfer-link failure, a parse error — kept in the file's row
 * so a swallowed failure is not read as a clean import. Apart from
 * DroppedPicksList (a cost centre a posting could not apply), and never a
 * "Posted —" notice.
 */
export function ImportWarningsNote({ warnings }: { warnings: readonly string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="ml-6 rounded border border-rose-500/30 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-500">
      <p className="font-medium">Imported with problems</p>
      <ul className="mt-1 space-y-0.5">
        {warnings.map((w, i) => <li key={i}>{w}</li>)}
      </ul>
    </div>
  );
}
