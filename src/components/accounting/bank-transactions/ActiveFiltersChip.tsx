/** ActiveFiltersChip - "N filters active · Clear" (WP3): a narrowed list always says so, with the way back. */

export function ActiveFiltersChip({ labels, onClear }: { labels: string[]; onClear: () => void }) {
  if (labels.length === 0) return null;
  return (
    <div data-testid="active-filters" className="flex flex-wrap items-center gap-2 px-6 py-1.5 text-xs">
      <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-amber-800 dark:text-amber-300"
        title={labels.join(', ')}>
        {labels.length} filter{labels.length !== 1 ? 's' : ''} active
      </span>
      <button type="button" onClick={onClear} data-testid="active-filters-clear"
        className="text-teal-700 underline hover:no-underline dark:text-teal-400">Clear</button>
    </div>
  );
}
