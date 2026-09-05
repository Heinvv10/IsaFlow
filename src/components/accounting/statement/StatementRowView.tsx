import type { CSSProperties, ReactNode } from 'react';
import { formatMoney, formatPct } from '@/lib/format/money';
import type { StatementColumns, StatementRow } from './statementModel';
import { VarianceBar } from './VarianceBar';
import { Sparkline } from './Sparkline';

const KIND_CLASS: Record<StatementRow['kind'], string> = {
  section: 'text-xs uppercase tracking-wide text-[var(--ff-text-tertiary)]',
  line: 'text-[var(--ff-text-secondary)]',
  subtotal: 'font-semibold border-t border-[var(--ff-text-primary)]',
  total: 'font-semibold border-t border-[var(--ff-text-primary)]',
  grand: 'font-bold border-t border-[var(--ff-text-primary)] [border-bottom:3px_double_var(--ff-text-primary)]',
};

// Inline style rather than a Tailwind arbitrary property: `var(--ff-fig-font)`
// as a CSS custom property value inside `[font-family:...]` is not reliably
// picked up by this repo's Tailwind content scan.
const FIG_STYLE: CSSProperties = { fontFamily: 'var(--ff-fig-font)' };
const FIG = 'text-right whitespace-nowrap tabular-nums';

export function StatementRowView({ row, columns, maxVariance, cents, expanded, onToggle, drill }: {
  row: StatementRow; columns: StatementColumns; maxVariance: number; cents: boolean;
  expanded: boolean; onToggle?: (code: string) => void; drill?: ReactNode;
}) {
  const isSection = row.kind === 'section';
  const pad = row.depth === 1 ? 'pl-8' : 'pl-3';
  const label = row.kind === 'line' && onToggle ? (
    <button type="button" onClick={() => onToggle(row.accountCode!)} aria-expanded={expanded}
      className="text-left hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ff-brand-500)]">
      <span className="font-mono text-xs text-[var(--ff-text-tertiary)] mr-2">{row.accountCode}</span>{row.label}
    </button>
  ) : row.label;
  const colSpan = 2 + (columns.prior ? 1 : 0) + (columns.variance ? 2 : 0) + (columns.trend ? 1 : 0);
  return (
    <>
      <tr data-kind={row.kind} className={`${KIND_CLASS[row.kind]} text-sm`}>
        <td className={`${pad} py-1.5`}>{label}</td>
        <td className={`${FIG} py-1.5 pr-3`} style={FIG_STYLE}>{isSection ? '' : formatMoney(row.actual, { cents })}</td>
        {columns.prior && <td className={`${FIG} py-1.5 pr-3 text-[var(--ff-text-tertiary)]`} style={FIG_STYLE}>{isSection || row.prior === undefined ? '' : formatMoney(row.prior, { cents })}</td>}
        {columns.variance && (
          <>
            <td className="w-36 px-2">{!isSection && row.variance !== undefined && <VarianceBar value={row.variance} max={maxVariance} favourable={row.favourable} />}</td>
            <td className={`${FIG} py-1.5 pr-3 text-xs`} style={{ ...FIG_STYLE, color: row.favourable === undefined ? undefined : row.favourable ? 'var(--ff-fav)' : 'var(--ff-unfav)' }}>
              {!isSection && row.variancePct !== undefined ? formatPct(row.variancePct) : ''}
            </td>
          </>
        )}
        {columns.trend && <td className="px-2 text-[var(--ff-text-secondary)]">{row.trend && <Sparkline points={row.trend} />}</td>}
      </tr>
      {expanded && drill && <tr data-kind="drill"><td colSpan={colSpan} className="p-0">{drill}</td></tr>}
    </>
  );
}
