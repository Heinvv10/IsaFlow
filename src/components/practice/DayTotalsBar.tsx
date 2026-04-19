/**
 * DayTotalsBar — presentational strip showing daily hour totals and value.
 * Renders an amber warning when total hours exceed 12.
 */

export interface DayTotalsBarProps {
  entries: Array<{ hours: number; billable: boolean; lineTotal: number | null }>;
}

function fmt(n: number, decimals = 2): string {
  return n.toFixed(decimals);
}

export function DayTotalsBar({ entries }: DayTotalsBarProps) {
  const totalHours = entries.reduce((acc, e) => acc + e.hours, 0);
  const billableHours = entries.reduce((acc, e) => acc + (e.billable ? e.hours : 0), 0);
  const nonBillableHours = totalHours - billableHours;
  const totalValue = entries.reduce(
    (acc, e) => acc + (e.lineTotal !== null ? e.lineTotal : 0),
    0,
  );

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 rounded-lg bg-[var(--ff-bg-secondary)] border border-[var(--ff-border-primary)] text-sm">
        <Stat label="Total" value={`${fmt(totalHours, 2)}h`} />
        <div className="w-px h-4 bg-[var(--ff-border-primary)] hidden sm:block" />
        <Stat label="Billable" value={`${fmt(billableHours, 2)}h`} highlight />
        <div className="w-px h-4 bg-[var(--ff-border-primary)] hidden sm:block" />
        <Stat label="Non-billable" value={`${fmt(nonBillableHours, 2)}h`} />
        <div className="w-px h-4 bg-[var(--ff-border-primary)] hidden sm:block" />
        <Stat label="Value" value={`R${fmt(totalValue, 2)}`} highlight />
      </div>

      {totalHours > 12 && (
        <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400 text-sm">
          <span className="font-semibold">Warning:</span>
          Day total exceeds 12h — please verify.
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  highlight = false,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[var(--ff-text-tertiary)] text-xs">{label}</span>
      <span className={highlight ? 'font-semibold text-teal-400' : 'font-medium text-[var(--ff-text-primary)]'}>
        {value}
      </span>
    </div>
  );
}
