/** One label/amount row of the EMP201 form (moved from pages/accounting/sars/emp201.tsx). */
export function SummaryRow({
  label,
  value,
  bold,
}: {
  label: string;
  value: string;
  bold?: boolean;
}) {
  return (
    <div className={`px-4 py-3 flex items-center justify-between ${bold ? 'bg-[var(--ff-bg-primary)]/30' : ''}`}>
      <span className={`text-sm ${bold ? 'font-semibold text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-secondary)]'}`}>
        {label}
      </span>
      <span className={`text-sm font-medium ${bold ? 'text-[var(--ff-text-primary)]' : 'text-[var(--ff-text-secondary)]'}`}>
        {value}
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
