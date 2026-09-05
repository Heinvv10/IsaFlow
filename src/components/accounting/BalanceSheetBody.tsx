/**
 * BalanceSheetBody — the loaded-report branch of the balance sheet page,
 * extracted so the page stays under the 300-line limit. Renders the shared
 * balanced / out-of-balance banner and the two StatementGrid columns
 * (Assets; Liabilities and Equity).
 */
import type { BalanceSheetReport } from '@/modules/accounting/types/gl.types';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';
import { BalanceCheckBanner } from '@/components/accounting/statement/BalanceCheckBanner';
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import { toBalanceSheetRows } from '@/components/accounting/statement/balanceSheetRows';

interface BalanceSheetBodyProps {
  report: BalanceSheetReport;
  showComparative: boolean;
  expandedAccount: string | null;
  onToggleAccount: (code: string) => void;
  drillDownStart: string;
  drillDownEnd: string;
  onEvidence: (accountId: string, accountName: string) => void;
}

export function BalanceSheetBody({
  report, showComparative, expandedAccount, onToggleAccount, drillDownStart, drillDownEnd, onEvidence,
}: BalanceSheetBodyProps) {
  const { assets, liabilitiesAndEquity } = toBalanceSheetRows(report, { comparative: showComparative });
  const columns = { prior: showComparative, variance: showComparative, trend: false };
  const nameOf = (code: string) =>
    [...report.assets, ...report.liabilities, ...report.equity].find(a => a.accountCode === code)?.accountName ?? code;
  const evidence = (code: string) => onEvidence(code, nameOf(code));
  const drill = (code: string) => (
    <AccountDrillDown accountCode={code} periodStart={drillDownStart} periodEnd={drillDownEnd} asTableRow={false} />
  );

  return (
    <div className="space-y-4">
      <BalanceCheckBanner
        totalAssets={report.totalAssets}
        totalLiabilities={report.totalLiabilities}
        totalEquity={report.totalEquity}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <StatementGrid rows={assets} columns={columns} title="Assets" cents
          expandedAccount={expandedAccount} onToggleAccount={onToggleAccount} renderDrill={drill} onEvidence={evidence} />
        <StatementGrid rows={liabilitiesAndEquity} columns={columns} title="Liabilities and Equity" cents
          expandedAccount={expandedAccount} onToggleAccount={onToggleAccount} renderDrill={drill} onEvidence={evidence} />
      </div>
    </div>
  );
}
