/**
 * One read-only CC1 / CC2 / BU cell on the Banking list. Shows the code (the
 * name in the tooltip). A value taken from the allocation journal rather than
 * the bank row itself is shown in italics and says so; a journal split across
 * projects shows "Split" — open the journal for the per-line values.
 */
interface Props {
  code?: string;
  name?: string;
  source?: 'bank' | 'journal' | 'split';
}

export function DimensionValue({ code, name, source }: Props) {
  if (source === 'split') {
    return (
      <span className="text-xs italic text-[var(--ff-text-tertiary)] block"
        title="The journal's lines carry more than one dimension set — open the journal to see each line">
        Split
      </span>
    );
  }
  const label = code || name;
  if (!label) return <span className="text-xs text-[var(--ff-text-tertiary)] block">—</span>;
  const fromJournal = source === 'journal';
  const title = `${code && name ? `${code} — ${name}` : label}${fromJournal ? ' (from the allocation journal)' : ''}`;
  return (
    <span className={`text-xs truncate block ${fromJournal ? 'italic text-[var(--ff-text-secondary)]' : 'text-[var(--ff-text-tertiary)]'}`}
      title={title}>
      {label}
    </span>
  );
}
