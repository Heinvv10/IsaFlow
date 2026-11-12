/** One label/amount row of the EMP201 form (moved from pages/accounting/sars/emp201.tsx). */
export function SummaryRow({
  label,
  value,
  bold,
  onDrill,
}: {
  label: string;
  value: string;
  bold?: boolean;
  /** Opens the lines behind this total (wave 5 L3u); set only when there is something to drill. */
  onDrill?: () => void;
}) {
  return (
    <div className={`px-4 py-3 flex items-center justify-between ${bold ? 'bg-[var(--ff-bg-primary)]/30' : ''}`}>
      <span className={`text-sm ${bold ? 'font-semibold text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-secondary)]'}`}>
        {label}
      </span>
      <span className="flex items-center gap-3">
        {onDrill && (
          <button type="button" onClick={onDrill} data-testid="emp201-drill-link" aria-label={`Show the lines behind ${label}`}
            className="min-h-[24px] text-xs text-teal-700 underline dark:text-teal-400">Lines</button>
        )}
        <span data-testid="emp201-value" className={`text-sm font-medium ${bold ? 'text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-secondary)]'}`}>
          {value}
        </span>
      </span>
    </div>
  );
}

/** A section heading inside the form card. */
export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-2 bg-blue-500/5">
      <p className="text-xs font-semibold text-blue-600 dark:text-blue-400 uppercase tracking-wider">{children}</p>
    </div>
  );
}
