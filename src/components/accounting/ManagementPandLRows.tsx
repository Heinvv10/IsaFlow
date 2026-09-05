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
import type { BalanceSheetDetail } from '@/modules/accounting/services/reports/statementRows/packMappers';
import { toManagementBsRows, toManagementPandLRows } from '@/modules/accounting/services/reports/statementRows/packMappers';

export function KVRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between py-1 text-sm border-b border-[var(--ff-border-light)] last:border-0 ${bold ? 'font-semibold' : ''}`}>
      <span className="text-[var(--ff-text-secondary)]">{label}</span>
      <span className="text-[var(--ff-text-primary)]">{value}</span>
    </div>
  );
}

export function ManagementPandLRows({ is }: { is: Record<string, number> | undefined }) {
  // The band list lives in the service layer, and it is the SAME list the HTML
  // and PDF packs render. A second copy here is a second chance to omit a
  // band, which is how the pack came to be short by other income less other
  // expenses on documents already sent to clients.
  return <StatementGrid rows={toManagementPandLRows(is)} columns={{ prior: false, budget: false, variance: false, trend: false }} cents />;
}

/** The management pack's balance-sheet summary — three subtotals plus the
 * derived Total Liabilities and Equity line (the report has no field for
 * this — same exception as balanceSheetRows.ts). `detail` copies in the
 * report's own current-assets/cash/AR/AP figures, no arithmetic. */
export function ManagementBalanceSheetRows({ bs, detail }: { bs: Record<string, number> | undefined; detail?: BalanceSheetDetail }) {
  return <StatementGrid rows={toManagementBsRows(bs, detail)} columns={{ prior: false, budget: false, variance: false, trend: false }} cents />;
}
