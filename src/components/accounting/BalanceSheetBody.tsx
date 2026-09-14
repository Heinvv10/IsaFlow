/**
 * BalanceSheetBody — the loaded-report branch of the balance sheet page,
 * extracted so the page stays under the 300-line limit. Renders the shared
 * balanced / out-of-balance banner and the two StatementGrid columns
 * (Assets; Equity and Liabilities).
 */
import type { BalanceSheetReport } from '@/modules/accounting/types/gl.types';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';
import { BalanceCheckBanner } from '@/components/accounting/statement/BalanceCheckBanner';
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import { toBalanceSheetRows } from '@/modules/accounting/services/reports/statementRows/balanceSheetRows';
import type { StatementColumns, StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import { comparativeOnlyColumns } from '@/modules/accounting/services/reports/statementRows/statementModel';

interface BalanceSheetBodyProps {
  report: BalanceSheetReport;
  showComparative: boolean;
  expandedAccount: string | null;
  onToggleAccount: (code: string) => void;
  drillDownStart: string;
  drillDownEnd: string;
  costCentreId?: string;
  businessUnitId?: string;
  returnTo?: string;
  onEvidence: (accountId: string, accountName: string) => void;
  /** Which comparator columns to print. Omitted, the prior-year checkbox alone
   *  decides, which is what every caller did before the trend column existed. */
  columns?: StatementColumns;
  /** Decorates the rows with the fetched comparators. Identity by default. */
  applyComparators?: (rows: StatementRow[]) => StatementRow[];
}

export function BalanceSheetBody({
  report, showComparative, expandedAccount, onToggleAccount, drillDownStart, drillDownEnd, onEvidence,
  costCentreId, businessUnitId, returnTo, columns: columnsProp, applyComparators = rows => rows,
}: BalanceSheetBodyProps) {
  // The account-detail route master's BalanceSheetRow linked every account
  // name to. The migration to StatementGrid dropped it; the row model now
  // carries an href and this is the only surface that sets one.
  const detailHref = (code: string) =>
    `/accounting/reports/account-detail/${encodeURIComponent(code)}` +
    `?from=${encodeURIComponent(drillDownStart)}&to=${encodeURIComponent(drillDownEnd)}&source=bs` +
    (costCentreId ? `&cost_centre_id=${encodeURIComponent(costCentreId)}` : '') +
    (businessUnitId ? `&business_unit_id=${encodeURIComponent(businessUnitId)}` : '') +
    (returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : '');
  const built = toBalanceSheetRows(report, { comparative: showComparative, detailHref });
  const assets = applyComparators(built.assets);
  const liabilitiesAndEquity = applyComparators(built.liabilitiesAndEquity);
  const columns = columnsProp ?? comparativeOnlyColumns(showComparative);
  const comparatorColumns = columns.prior || columns.budget || columns.trend;
  const nameOf = (code: string) =>
    [...report.assets, ...report.liabilities, ...report.equity].find(a => a.accountCode === code)?.accountName ?? code;
  const evidence = (code: string) => onEvidence(code, nameOf(code));
  const drill = (code: string) => (
    <AccountDrillDown accountCode={code} periodStart={drillDownStart} periodEnd={drillDownEnd}
      costCentreId={costCentreId} businessUnitId={businessUnitId} source="bs" returnTo={returnTo}
      asTableRow={false} />
  );

  return (
    <div className="space-y-4">
      <BalanceCheckBanner
        totalAssets={report.totalAssets}
        totalLiabilities={report.totalLiabilities}
        totalEquity={report.totalEquity}
      />

      {/* Side by side while each grid is two columns wide. With a comparator
          or the trend column on, seven columns do not fit in half a screen and
          both halves clip their right-hand columns, so the grids stack. */}
      <div className={comparatorColumns ? 'space-y-4' : 'grid grid-cols-1 lg:grid-cols-2 gap-4'}>
        <StatementGrid rows={assets} columns={columns} title="Assets" cents
          expandedAccount={expandedAccount} onToggleAccount={onToggleAccount} renderDrill={drill} onEvidence={evidence} />
        <StatementGrid rows={liabilitiesAndEquity} columns={columns} title="Equity and Liabilities" cents
          expandedAccount={expandedAccount} onToggleAccount={onToggleAccount} renderDrill={drill} onEvidence={evidence} />
      </div>
    </div>
  );
}
