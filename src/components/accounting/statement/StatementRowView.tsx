import type { CSSProperties, ReactNode } from 'react';
import { Fragment } from 'react';
import Link from 'next/link';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { formatStatementFigure, formatPct } from '@/lib/format/money';
import type { ComparatorKey, Comparison, StatementColumns, StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import { COMPARATORS, NON_FIGURE_KINDS } from '@/modules/accounting/services/reports/statementRows/statementModel';
import { NoteMarker } from '@/components/accounting/annotations/NoteMarker';
import { VarianceBar } from './VarianceBar';
import { Sparkline } from './Sparkline';
import { STICKY_FIRST_CELL } from './stickyTable';

const KIND_CLASS: Record<StatementRow['kind'], string> = {
  section: 'text-xs uppercase tracking-wide text-[var(--ff-text-tertiary)]',
  empty: 'text-xs italic text-[var(--ff-text-tertiary)]',
  line: 'text-[var(--ff-text-secondary)]',
  subtotal: 'font-semibold border-t border-[var(--ff-text-primary)]',
  total: 'font-semibold border-t border-[var(--ff-text-primary)]',
  grand: 'font-bold border-t border-[var(--ff-text-primary)] [border-bottom:3px_double_var(--ff-text-primary)]',
};

// Inline style rather than a Tailwind arbitrary property: `var(--ff-fig-font)`
// as a CSS custom property value inside `[font-family:...]` is not reliably
// picked up by this repo's Tailwind content scan.
const FIG_STYLE: CSSProperties = { fontFamily: 'var(--ff-fig-font, inherit)' };
const FIG = 'text-right whitespace-nowrap tabular-nums';

// One focus ring for every interactive element in a row. The chevron in the
// linked branch was declared without it while its unlinked sibling had it, so
// a keyboard user saw a different ring on the two balance-sheet row shapes.
// Written out in full rather than composed, so Tailwind's content scan sees it.
const FOCUS_RING =
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--ff-brand-500)]';

const favColour = (favourable?: boolean) =>
  favourable === undefined ? undefined : favourable ? 'var(--ff-fav)' : 'var(--ff-unfav)';

/** The rand movement, signed. Negatives already read as parentheses through
 * formatStatementFigure, so only a positive needs its sign written on. Master showed
 * this on every balance-sheet line and the first migration dropped it. */
function varianceAmount(v: number, cents: boolean): string {
  const body = formatStatementFigure(v, { cents });
  return v > 0 ? `+${body}` : body;
}

/** "—" for a comparator that does not exist (`Comparison.absent`), never the zero dash. */
const ABSENT = '—';
const ABSENT_TITLE: Record<NonNullable<Comparison['absentReason']>, string> = {
  partial: 'Budget covers only part of this window',
  'above-filter': 'Budget set above this filter',
};

function AbsentCell({ reason }: { reason?: Comparison['absentReason'] }) {
  if (!reason) return <span title="No budget">{ABSENT}</span>;
  return (
    <span title={ABSENT_TITLE[reason]} data-absent-reason={reason}>
      {ABSENT}<sup aria-hidden="true" className="ml-0.5 text-[var(--ff-text-tertiary)]">{reason === 'partial' ? '½' : '↑'}</sup>
      <span className="sr-only">{ABSENT_TITLE[reason]}</span>
    </span>
  );
}

function ComparatorCells({ c, blank, columns, maxVariance, cents, comparatorKey }: {
  c: Comparison | undefined; blank: boolean; columns: StatementColumns;
  maxVariance: Record<ComparatorKey, number>; cents: boolean; comparatorKey: ComparatorKey;
}) {
  const show = !blank && c !== undefined;
  // An absent comparator prints "—" in every cell, with no bar and no colour.
  const absent = show && c.absent === true;
  return (
    <>
      <td className={`${FIG} py-1.5 pr-3 text-[var(--ff-text-tertiary)]`} style={FIG_STYLE}>
        {absent ? <AbsentCell reason={c.absentReason} /> : show ? formatStatementFigure(c.value, { cents }) : ''}
      </td>
      {columns.variance && (
        <>
          <td className={`${FIG} py-1.5 pr-3 text-xs`} style={{ ...FIG_STYLE, color: absent ? undefined : favColour(c?.favourable) }}>
            {absent ? ABSENT : show && c.variance !== undefined ? varianceAmount(c.variance, cents) : ''}
          </td>
          <td className="w-36 px-2">
            {show && !absent && c.variance !== undefined && (
              <VarianceBar value={c.variance} max={maxVariance[comparatorKey]} favourable={c.favourable} />
            )}
          </td>
          <td className={`${FIG} py-1.5 pr-3 text-xs`} style={{ ...FIG_STYLE, color: absent ? undefined : favColour(c?.favourable) }}>
            {absent ? ABSENT : show && c.variancePct !== undefined ? formatPct(c.variancePct) : ''}
          </td>
        </>
      )}
    </>
  );
}

/** Projected FY / FY budget / Δ, Budget vs Actual only (`columns.projection`). */
function ProjectionCells({ row, blank, cents }: { row: StatementRow; blank: boolean; cents: boolean }) {
  const p = blank ? undefined : row.projection;
  const none = p === undefined;
  return (
    <>
      <td data-col="projected" className={`${FIG} py-1.5 pr-3`} style={FIG_STYLE}>{none ? '' : formatStatementFigure(p.projected, { cents })}</td>
      <td className={`${FIG} py-1.5 pr-3 text-[var(--ff-text-tertiary)]`} style={FIG_STYLE}>
        {none ? '' : p.absent || p.fyBudget === undefined ? <span title="No FY budget">{ABSENT}</span> : formatStatementFigure(p.fyBudget, { cents })}
      </td>
      <td className={`${FIG} py-1.5 pr-3 text-xs`} style={{ ...FIG_STYLE, color: none || p.absent ? undefined : favColour(p.favourable) }}>
        {none ? '' : p.absent || p.variance === undefined ? ABSENT : varianceAmount(p.variance, cents)}
      </td>
    </>
  );
}

/** The account label. With an `href` the name is a LINK to account detail and
 * the expand chevron is a SIBLING button — never an anchor inside a button,
 * which is invalid HTML and swallows one of the two actions. */
function RowLabel({ row, expanded, onToggle }: {
  row: StatementRow; expanded: boolean; onToggle?: (code: string) => void;
}) {
  const code = row.accountCode;
  const toggles = row.kind === 'line' && onToggle !== undefined && code !== undefined;
  const codeTag = <span className="font-mono text-xs text-[var(--ff-text-tertiary)] mr-2">{code}</span>;

  if (row.href !== undefined && code !== undefined) {
    return (
      <span className="flex items-center gap-1">
        {toggles && (
          <button type="button" onClick={() => onToggle!(code)} aria-expanded={expanded}
            aria-label={expanded ? 'Collapse' : 'Expand'}
            className={`p-0.5 text-[var(--ff-text-tertiary)] shrink-0 ${FOCUS_RING}`}>
            {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </button>
        )}
        {codeTag}
        <Link href={row.href} className={`hover:underline hover:text-[var(--ff-brand-500)] ${FOCUS_RING}`}>{row.label}</Link>
      </span>
    );
  }
  // A `line` row on the management and pack surfaces carries no account code,
  // so the toggle button must not be rendered there: it would call back with
  // undefined.
  if (toggles) {
    return (
      <button type="button" onClick={() => onToggle!(code!)} aria-expanded={expanded}
        className={`text-left hover:underline ${FOCUS_RING}`}>
        {codeTag}{row.label}
      </button>
    );
  }
  return <>{row.label}</>;
}

export function StatementRowView({ row, columns, maxVariance, cents, stickyFirst = false, expanded, onToggle, onEvidence, onOpenNote, drill }: {
  row: StatementRow; columns: StatementColumns; maxVariance: Record<ComparatorKey, number>; cents: boolean;
  /** Pin the label column on horizontal scroll (see StatementGrid `sticky`). */
  stickyFirst?: boolean;
  expanded: boolean; onToggle?: (code: string) => void; onEvidence?: (code: string) => void;
  onOpenNote?: (rowId: string) => void; drill?: ReactNode;
}) {
  // A band header repeats its subtotal's figure and the placeholder has none:
  // neither prints a number.
  const blank = NON_FIGURE_KINDS.has(row.kind);
  const pad = row.depth === 1 ? 'pl-8' : 'pl-3';
  const code = row.accountCode;
  const active = COMPARATORS.filter(c => columns[c.key]);
  const colSpan = 2 + active.length * (1 + (columns.variance ? 3 : 0)) + (columns.trend ? 1 : 0) + (columns.projection ? 3 : 0);
  return (
    <>
      <tr data-kind={row.kind} className={`${KIND_CLASS[row.kind]} text-sm`}>
        <td className={`${pad} py-1.5 ${stickyFirst ? STICKY_FIRST_CELL : ''}`}>
          <span className="flex items-center gap-1">
            <RowLabel row={row} expanded={expanded} onToggle={onToggle} />
            {row.note && onOpenNote && (
              <NoteMarker note={row.note} onClick={() => onOpenNote(row.id)} label={row.label} />
            )}
          </span>
        </td>
        <td className={`${FIG} py-1.5 pr-3`} style={FIG_STYLE}>{blank ? '' : formatStatementFigure(row.actual, { cents })}</td>
        {active.map(c => (
          <Fragment key={c.key}>
            <ComparatorCells c={row[c.key]} blank={blank} columns={columns}
              maxVariance={maxVariance} cents={cents} comparatorKey={c.key} />
          </Fragment>
        ))}
        {columns.trend && <td className="px-2 text-[var(--ff-text-secondary)]">{row.trend && <Sparkline points={row.trend} />}</td>}
        {columns.projection && <ProjectionCells row={row} blank={blank} cents={cents} />}
      </tr>
      {expanded && code !== undefined && (drill || onEvidence) && (
        <tr data-kind="drill">
          <td colSpan={colSpan} className="p-0">
            {onEvidence && (
              <div className="px-3 pt-2">
                <button type="button" onClick={() => onEvidence(code)}
                  className="text-xs px-2 py-1 rounded border border-[var(--ff-border-light)] text-[var(--ff-text-secondary)] hover:text-[var(--ff-text-primary)] hover:border-[var(--ff-brand-500)]">
                  Evidence
                </button>
              </div>
            )}
            {drill}
          </td>
        </tr>
      )}
    </>
  );
}
