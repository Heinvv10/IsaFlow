/** ActiveFiltersChip - "N filters active · Clear" (WP3): a narrowed list always says so, with the way back. */

export function ActiveFiltersChip({ labels, onClear }: { labels: string[]; onClear: () => void }) {
  if (labels.length === 0) return null;
  return (
    <div data-testid="active-filters" className="flex flex-wrap items-center gap-2 px-6 py-1.5 text-xs">
      <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-amber-800 dark:text-amber-300">
        {labels.length} filter{labels.length !== 1 ? 's' : ''} active
      </span>
      {/* The names are text on the page (not a hover title): keyboard and screen-reader users read them too. */}
      <ul data-testid="active-filters-names" className="flex flex-wrap gap-1.5 text-[var(--ff-text-secondary)]" aria-label="Active filters">
        {labels.map(l => <li key={l} className="rounded border border-[var(--ff-border-light)] px-1.5 py-0.5">{l}</li>)}
      </ul>
      <button type="button" onClick={onClear} data-testid="active-filters-clear"
        className="text-teal-700 underline hover:no-underline dark:text-teal-400">Clear</button>
    </div>
  );
}
