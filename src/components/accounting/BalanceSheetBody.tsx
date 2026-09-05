/**
 * BalanceSheetBody — the loaded-report branch of the balance sheet page,
 * extracted so the page stays under the 300-line limit. Renders the
 * balanced / out-of-balance banner (reads service totals, unchanged) and the
 * two StatementGrid columns (Assets; Liabilities and Equity).
 */
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import type { BalanceSheetReport } from '@/modules/accounting/types/gl.types';
import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import { toBalanceSheetRows } from '@/components/accounting/statement/balanceSheetRows';
import { formatCurrency } from '@/utils/formatters';

interface BalanceSheetBodyProps {
  report: BalanceSheetReport;
  showComparative: boolean;
  expandedAccount: string | null;
  onToggleAccount: (code: string) => void;
  drillDownStart: string;
  drillDownEnd: string;
}

export function BalanceSheetBody({
  report, showComparative, expandedAccount, onToggleAccount, drillDownStart, drillDownEnd,
}: BalanceSheetBodyProps) {
  const balanced = Math.abs(report.totalAssets - (report.totalLiabilities + report.totalEquity)) < 0.02;
  const { assets, liabilitiesAndEquity } = toBalanceSheetRows(report, { comparative: showComparative });
  const columns = { prior: showComparative, variance: showComparative, trend: false };
  const drill = (code: string) => (
    <AccountDrillDown accountCode={code} periodStart={drillDownStart} periodEnd={drillDownEnd} asTableRow={false} />
  );

  return (
    <div className="space-y-4">
      {balanced && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-teal-500/10 text-teal-400 text-sm">
          <CheckCircle2 className="h-4 w-4" /> Balance sheet is balanced (A = L + E)
        </div>
      )}
      {!balanced && report.totalAssets > 0 && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-400 text-sm">
          <AlertCircle className="h-4 w-4" /> Out of balance by {formatCurrency(Math.abs(report.totalAssets - (report.totalLiabilities + report.totalEquity)))}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <StatementGrid rows={assets} columns={columns} title="Assets" cents
          expandedAccount={expandedAccount} onToggleAccount={onToggleAccount} renderDrill={drill} />
        <StatementGrid rows={liabilitiesAndEquity} columns={columns} title="Liabilities and Equity" cents
          expandedAccount={expandedAccount} onToggleAccount={onToggleAccount} renderDrill={drill} />
      </div>
    </div>
  );
}
