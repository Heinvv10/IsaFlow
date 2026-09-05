/**
 * The management pack's P&L rows — every band, so the pack FOOTS.
 *
 * Turnover less cost of sales less operating expenses misses Net Profit by
 * exactly other income minus other expenses — R341,712.00 on Brightsphere — and
 * this pack is a document people send onward. Its own file so the bands are
 * testable without dragging the page's layout and font imports into a unit
 * test: deleting the Operating Profit or Other Income row left the whole suite
 * green.
 */
import { StatementGrid } from '@/components/accounting/statement/StatementGrid';
import type { StatementRow } from '@/components/accounting/statement/statementModel';

export function KVRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between py-1 text-sm border-b border-[var(--ff-border-light)] last:border-0 ${bold ? 'font-semibold' : ''}`}>
      <span className="text-[var(--ff-text-secondary)]">{label}</span>
      <span className="text-[var(--ff-text-primary)]">{value}</span>
    </div>
  );
}

export function ManagementPandLRows({ is }: { is: Record<string, number> | undefined }) {
  const n = (k: string) => is?.[k] ?? 0;
  const rows: StatementRow[] = [
    { id: 'sub:revenue', kind: 'subtotal', label: 'Turnover', depth: 0, actual: n('totalRevenue') },
    { id: 'sub:costOfSales', kind: 'line', label: 'Cost of Sales', depth: 0, actual: n('totalCostOfSales') },
    { id: 'total:grossProfit', kind: 'total', label: 'Gross Profit', depth: 0, actual: n('grossProfit') },
    ...(n('totalOtherIncome') !== 0 ? [{ id: 'sub:otherIncome', kind: 'line' as const, label: 'Other Income', depth: 0 as const, actual: n('totalOtherIncome') }] : []),
    { id: 'sub:operatingExpenses', kind: 'line', label: 'Operating Expenses', depth: 0, actual: n('totalOperatingExpenses') },
    { id: 'total:operatingProfit', kind: 'total', label: 'Operating Profit', depth: 0, actual: n('operatingProfit') },
    ...(n('totalOtherExpenses') !== 0 ? [{ id: 'sub:otherExpenses', kind: 'line' as const, label: 'Other Expenses', depth: 0 as const, actual: n('totalOtherExpenses') }] : []),
    { id: 'grand:netProfit', kind: 'grand', label: 'Net Profit', depth: 0, actual: n('netProfit') },
  ];
  return <StatementGrid rows={rows} columns={{ prior: false, variance: false, trend: false }} cents />;
}

export interface BalanceSheetDetail {
  currentAssets?: number;
  cash?: number;
  accountsReceivable?: number;
  accountsPayable?: number;
}

/** The management pack's balance-sheet summary — three subtotals plus the
 * derived Total Liabilities and Equity line (the report has no field for
 * this — same exception as balanceSheetRows.ts). `detail` copies in the
 * report's own current-assets/cash/AR/AP figures, no arithmetic. */
export function ManagementBalanceSheetRows({ bs, detail }: { bs: Record<string, number> | undefined; detail?: BalanceSheetDetail }) {
  const n = (k: string) => bs?.[k] ?? 0;
  const rows: StatementRow[] = [
    { id: 'sub:totalAssets', kind: 'subtotal', label: 'Total Assets', depth: 0, actual: n('totalAssets') },
    ...(detail?.currentAssets !== undefined ? [{ id: 'line:currentAssets', kind: 'line' as const, label: 'Current Assets', depth: 1 as const, actual: detail.currentAssets }] : []),
    ...(detail?.cash !== undefined ? [{ id: 'line:cash', kind: 'line' as const, label: 'Cash', depth: 1 as const, actual: detail.cash }] : []),
    ...(detail?.accountsReceivable !== undefined ? [{ id: 'line:accountsReceivable', kind: 'line' as const, label: 'Accounts Receivable', depth: 1 as const, actual: detail.accountsReceivable }] : []),
    { id: 'sub:totalLiabilities', kind: 'subtotal', label: 'Total Liabilities', depth: 0, actual: n('totalLiabilities') },
    ...(detail?.accountsPayable !== undefined ? [{ id: 'line:accountsPayable', kind: 'line' as const, label: 'Accounts Payable', depth: 1 as const, actual: detail.accountsPayable }] : []),
    { id: 'sub:totalEquity', kind: 'subtotal', label: 'Total Equity', depth: 0, actual: n('totalEquity') },
    { id: 'grand:totalLiabAndEquity', kind: 'grand', label: 'Total Liabilities and Equity', depth: 0, actual: n('totalLiabilities') + n('totalEquity') },
  ];
  return <StatementGrid rows={rows} columns={{ prior: false, variance: false, trend: false }} cents />;
}
