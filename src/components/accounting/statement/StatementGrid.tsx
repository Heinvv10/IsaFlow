/**
 * The one statement renderer. Renders StatementRow[] and nothing else: it
 * does not add, subtract or derive. Adapters (incomeStatementRows,
 * balanceSheetRows) own the mapping from service output to rows.
 */
import { Fragment, type ReactNode } from 'react';
import type { ComparatorKey, StatementColumns, StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import { COMPARATORS } from '@/modules/accounting/services/reports/statementRows/statementModel';
import { StatementRowView } from './StatementRowView';
import { STICKY_FIRST_HEAD, STICKY_HEAD } from './stickyTable';

export interface StatementGridProps {
  rows: StatementRow[];
  columns: StatementColumns;
  title?: string;
  expandedAccount?: string | null;
  onToggleAccount?: (code: string) => void;
  /** Rendered as a full-width row directly under the expanded line. */
  renderDrill?: (accountCode: string) => ReactNode;
  /** Opens the evidence drill for an account. Rendered as a button inside the
   * expanded drill row; omit it and no evidence affordance appears. */
  onEvidence?: (accountCode: string) => void;
  /** Opens the note thread for a row. Omit it and no note marker appears, which
   * is what the share and PDF surfaces do — annotations are internal. */
  onOpenNote?: (rowId: string) => void;
  cents?: boolean;
  /** Sticky header row and first column, pinned to the page scroll (see stickyTable.ts). For the
   * on-screen report pages; the share, slide and pack surfaces render the table as before. */
  sticky?: boolean;
}

export function StatementGrid({ rows, columns, title, expandedAccount, onToggleAccount, renderDrill, onEvidence, onOpenNote, cents = false, sticky = false }: StatementGridProps) {
  const active = COMPARATORS.filter(c => columns[c.key]);
  // One bar scale PER COMPARATOR. Sharing one scale across prior and budget
  // would draw a small budget movement at the size of a large prior one.
  const maxVariance = Object.fromEntries(
    COMPARATORS.map(c => [
      c.key,
      rows.reduce((m, r) => {
        const v = r[c.key]?.variance;
        return r.kind === 'line' && v !== undefined ? Math.max(m, Math.abs(v)) : m;
      }, 0),
    ]),
  ) as Record<ComparatorKey, number>;
  return (
    <div className={`${sticky ? '' : 'overflow-x-auto'} rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]`}>
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-[var(--ff-text-tertiary)] border-b border-[var(--ff-border-secondary)]">
            <th className={`text-left pl-3 py-2 font-medium ${sticky ? STICKY_FIRST_HEAD : ''}`}>{title ?? ''}</th>
            <th className={`text-right pr-3 py-2 font-medium ${sticky ? STICKY_HEAD : ''}`}>Actual</th>
            {active.map(c => (
              <Fragment key={c.key}>
                <th className={`text-right pr-3 py-2 font-medium ${sticky ? STICKY_HEAD : ''}`}>{c.label}</th>
                {columns.variance && (
                  <>
                    <th className={`text-right pr-3 py-2 font-medium ${sticky ? STICKY_HEAD : ''}`}>{`Δ ${c.label}`}</th>
                    <th className={`py-2 font-medium ${sticky ? STICKY_HEAD : ''}`}>Variance</th>
                    <th className={`text-right pr-3 py-2 font-medium ${sticky ? STICKY_HEAD : ''}`}>Δ%</th>
                  </>
                )}
              </Fragment>
            ))}
            {columns.trend && <th className={`py-2 font-medium ${sticky ? STICKY_HEAD : ''}`}>12 mo</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const expanded = row.accountCode !== undefined && row.accountCode === expandedAccount;
            return (
              <StatementRowView key={row.id} row={row} columns={columns} maxVariance={maxVariance} cents={cents}
                stickyFirst={sticky}
                expanded={expanded}
                onToggle={onToggleAccount}
                onEvidence={onEvidence}
                onOpenNote={onOpenNote}
                // Only the expanded row's drill is built. Building one per
                // coded row and discarding it fetches nothing, but it is a
                // render's worth of work per account on a long statement.
                drill={expanded && row.accountCode && renderDrill ? renderDrill(row.accountCode) : undefined} />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
