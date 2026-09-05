/**
 * The one statement renderer. Renders StatementRow[] and nothing else: it
 * does not add, subtract or derive. Adapters (incomeStatementRows,
 * balanceSheetRows) own the mapping from service output to rows.
 */
import type { ReactNode } from 'react';
import type { StatementColumns, StatementRow } from './statementModel';
import { StatementRowView } from './StatementRowView';

export interface StatementGridProps {
  rows: StatementRow[];
  columns: StatementColumns;
  title?: string;
  expandedAccount?: string | null;
  onToggleAccount?: (code: string) => void;
  /** Rendered as a full-width row directly under the expanded line. */
  renderDrill?: (accountCode: string) => ReactNode;
  cents?: boolean;
}

export function StatementGrid({ rows, columns, title, expandedAccount, onToggleAccount, renderDrill, cents = false }: StatementGridProps) {
  const maxVariance = rows.reduce((m, r) => (r.kind === 'line' && r.variance !== undefined ? Math.max(m, Math.abs(r.variance)) : m), 0);
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--ff-border-light)] bg-[var(--ff-bg-secondary)]">
      <table className="w-full border-collapse">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-[var(--ff-text-tertiary)] border-b border-[var(--ff-border-secondary)]">
            <th className="text-left pl-3 py-2 font-medium">{title ?? ''}</th>
            <th className="text-right pr-3 py-2 font-medium">Actual</th>
            {columns.prior && <th className="text-right pr-3 py-2 font-medium">Prior</th>}
            {columns.variance && <><th className="py-2 font-medium">Variance</th><th className="text-right pr-3 py-2 font-medium">Δ%</th></>}
            {columns.trend && <th className="py-2 font-medium">12 mo</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <StatementRowView key={row.id} row={row} columns={columns} maxVariance={maxVariance} cents={cents}
              expanded={row.accountCode !== undefined && row.accountCode === expandedAccount}
              onToggle={onToggleAccount}
              drill={row.accountCode && renderDrill ? renderDrill(row.accountCode) : undefined} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
