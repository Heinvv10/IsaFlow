import type { CSSProperties } from 'react';
import { formatMoney, formatPct } from '@/lib/format/money';
import { Sparkline } from '@/components/accounting/statement/Sparkline';

/**
 * The one KPI tile. Replaces KpiCard (management-accounts) and KPICard
 * (executive-dashboard). Value, comparator, signed delta, optional sparkline.
 * Colour is semantic only: favourable / unfavourable.
 */
export interface KpiTileProps {
  label: string;
  value: number;
  kind: 'money' | 'pct' | 'ratio';
  comparator?: { label: string; value: number };
  deltaPct?: number;
  favourable?: boolean;
  trend?: number[];
  note?: string;
}

// Inline style rather than a Tailwind arbitrary property, per the convention
// StatementRowView.tsx settled on: `var(--ff-fig-font)` inside
// `[font-family:...]` is not reliably picked up by the Tailwind content scan.
const FIG_STYLE: CSSProperties = { fontFamily: 'var(--ff-fig-font)' };

function fmt(v: number, kind: KpiTileProps['kind']): string {
  if (kind === 'money') return formatMoney(v, { symbol: true });
  if (kind === 'pct') return `${v.toFixed(1)}%`;
  return v.toFixed(2);
}

export function KpiTile({ label, value, kind, comparator, deltaPct, favourable, trend, note }: KpiTileProps) {
  const deltaColour = favourable === undefined ? 'var(--ff-text-tertiary)' : favourable ? 'var(--ff-fav)' : 'var(--ff-unfav)';
  return (
    <div className="rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)] p-4 flex flex-col gap-2">
      <span className="text-xs uppercase tracking-wide text-[var(--ff-text-tertiary)]">{label}</span>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-2xl font-semibold tabular-nums text-[var(--ff-text-primary)]" style={FIG_STYLE}>
          {fmt(value, kind)}
        </span>
        {deltaPct !== undefined && (
          <span
            data-fav={favourable === undefined ? undefined : String(favourable)}
            className="text-sm tabular-nums"
            style={{ ...FIG_STYLE, color: deltaColour }}
          >
            {formatPct(deltaPct)}
          </span>
        )}
      </div>
      {(comparator || (trend && trend.length > 1)) && (
        <div className="flex items-center justify-between gap-3 text-xs text-[var(--ff-text-tertiary)]">
          {comparator && (
            <span>
              {comparator.label} <span className="tabular-nums" style={FIG_STYLE}>{fmt(comparator.value, kind)}</span>
            </span>
          )}
          {trend && trend.length > 1 && (
            <span className="text-[var(--ff-text-secondary)]">
              <Sparkline points={trend} />
            </span>
          )}
        </div>
      )}
      {note && <span className="text-xs text-[var(--ff-text-secondary)]">{note}</span>}
    </div>
  );
}
