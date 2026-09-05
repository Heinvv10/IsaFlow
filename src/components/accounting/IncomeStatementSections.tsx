/**
 * The income statement body — every band, in the order a reader reconciles
 * them: Turnover, Cost of Sales, Gross Profit, Other Income, Operating
 * Expenses, Operating Profit, Other Expenses, Net Profit.
 *
 * Its own file so the ORDER and the presence of each band are testable without
 * dragging the page's layout and font imports into a unit test. Four of the
 * five surfaces that render these bands had no test at all: a whole section
 * could be deleted with the full suite green, which is how the statutory AFS
 * statement came to be missing two bands and stopped footing.
 */
import type { IncomeStatementReport } from '@/modules/accounting/types/gl.types';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';
import { DataQualityNotice } from '@/components/accounting/DataQualityNotice';
import { formatMoney } from '@/lib/format/money';
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import { toIncomeStatementRows } from '@/modules/accounting/services/reports/statementRows/incomeStatementRows';
import type { StatementColumns, StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';

export function IncomeStatementSections({
  report, periodStart, periodEnd, expandedAccount, onToggleAccount, showComparative, onEvidence,
  columns, applyComparators = rows => rows,
}: {
  report: IncomeStatementReport;
  periodStart: string;
  periodEnd: string;
  expandedAccount: string | null;
  onToggleAccount: (code: string) => void;
  showComparative: boolean;
  onEvidence: (accountId: string, accountName: string) => void;
  /** Which comparator columns to print. Omitted, the prior-period checkbox
   *  alone decides, which is what every caller did before the trend and
   *  budget columns existed. */
  columns?: StatementColumns;
  /** Decorates the rows with the fetched comparators. Identity by default, so
   *  a surface that offers no comparator controls renders exactly as before. */
  applyComparators?: (rows: StatementRow[]) => StatementRow[];
}) {
  const cols = columns ?? { prior: showComparative, budget: false, variance: showComparative, trend: false };
  const rows = applyComparators(toIncomeStatementRows(report, { comparative: showComparative }));
  // The evidence drill is opened from inside the expanded account row. The
  // grid speaks account codes only, so the name comes back off the row it
  // belongs to.
  const nameOf = (code: string) => rows.find(r => r.accountCode === code)?.label ?? code;
  return (
    <div>
      <StatementGrid
        rows={rows}
        columns={cols}
        title="Statement of Comprehensive Income"
        expandedAccount={expandedAccount}
        onToggleAccount={onToggleAccount}
        onEvidence={code => onEvidence(code, nameOf(code))}
        cents
        renderDrill={code => (
          <AccountDrillDown accountCode={code} periodStart={periodStart} periodEnd={periodEnd} asTableRow={false} />
        )}
      />

      {/* The shared data-quality notice, rendered ABOVE the margin
          stats on purpose: the gross margin immediately below is the
          figure these defaults make wrong, and Velocity read 96.6%
          off that line while R82.7m of direct cost sat in operating
          expenses. Same component, wording and currency format as the
          nine other report surfaces — a user comparing two screens
          must not see the same defect described two ways. */}
      {report.subtypeDisclosure && (
        <div className="px-6 py-3 border-t border-[var(--ff-border-light)]">
          {/* The service already built these sentences, and the CSV and
              XLSX exports emit the same array. Passing them through —
              rather than re-deriving a partial input here — is what
              stops the screen showing fewer caveats than the file
              downloaded from it, and stops a count being taken from
              the CAPPED named list. */}
          <DataQualityNotice notices={report.subtypeDisclosure.notices} />
          <p className="mt-2 font-mono text-xs text-[var(--ff-text-tertiary)]">
            {report.subtypeDisclosure.accounts
              .map(a => `${a.accountCode} ${a.accountName} ${formatMoney(a.amount, { cents: true, symbol: true })}`)
              .join(' · ')}
            {report.subtypeDisclosure.unnamedAccounts > 0
              ? ` · and ${report.subtypeDisclosure.unnamedAccounts} more`
              : ''}
          </p>
          {report.priorSubtypeDisclosure && (
            <p className="mt-1 text-xs text-amber-400/80">
              The comparative period has its own unclassified accounts, so every
              variance above is a difference between two differently-banded numbers.
            </p>
          )}
        </div>
      )}

      {/* Margin Stats — both ratios come from the service (grossMarginPct /
          netMarginPct). Deriving them here is what let the screen quote a
          margin no other surface agreed with. */}
      {report.grossMarginPct != null && report.netMarginPct != null && (
        <div className="px-6 py-2 flex gap-6 text-sm border-t border-[var(--ff-border-light)] bg-[var(--ff-bg-tertiary)]">
          <span className="text-[var(--ff-text-tertiary)]">
            Gross Margin:{' '}
            <span className="font-mono font-medium text-[var(--ff-text-primary)]">
              {report.grossMarginPct.toFixed(1)}%
            </span>
          </span>
          <span className="text-[var(--ff-text-tertiary)]">
            Net Margin:{' '}
            <span className="font-mono font-medium text-[var(--ff-text-primary)]">
              {report.netMarginPct.toFixed(1)}%
            </span>
          </span>
        </div>
      )}
    </div>
  );
}
