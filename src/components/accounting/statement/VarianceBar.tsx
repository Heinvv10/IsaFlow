/** Zero-centred bar. Width is |value| / max of the column, so one scale per statement. */
export function VarianceBar({ value, max, favourable }: { value: number; max: number; favourable?: boolean }) {
  const pct = max > 0 ? Math.min(50, (Math.abs(value) / max) * 50) : 0;
  const colour = favourable === undefined ? 'var(--ff-text-tertiary)' : favourable ? 'var(--ff-fav)' : 'var(--ff-unfav)';
  const side = value >= 0 ? { left: '50%' } : { right: '50%' };
  return (
    <div className="relative h-4 w-full" aria-hidden="true">
      <span className="absolute left-1/2 top-0 bottom-0 w-px bg-[var(--ff-border-secondary)]" />
      <span className="absolute top-0.5 h-3" style={{ ...side, width: `${pct}%`, background: colour }} />
    </div>
  );
}
