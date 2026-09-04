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
import { formatCurrency } from '@/utils/formatters';

export function KVRow({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex justify-between py-1 text-sm border-b border-[var(--ff-border-light)] last:border-0 ${bold ? 'font-semibold' : ''}`}>
      <span className="text-[var(--ff-text-secondary)]">{label}</span>
      <span className="text-[var(--ff-text-primary)]">{value}</span>
    </div>
  );
}


export function ManagementPandLRows({ is }: { is: Record<string, number> | undefined }) {
  return (
    <>
                  {/* Every band, so the pack FOOTS. Turnover less cost of sales
                      stopped equalling gross profit less operating expenses the
                      moment other income and finance cost/tax got their own
                      lines, and this pack is a document people send onward. */}
                  <KVRow label="Turnover" value={formatCurrency(is?.totalRevenue ?? 0)} bold />
                  <KVRow label="Cost of Sales" value={formatCurrency(is?.totalCostOfSales ?? 0)} />
                  <KVRow label="Gross Profit" value={formatCurrency(is?.grossProfit ?? 0)} bold />
                  {(is?.totalOtherIncome ?? 0) !== 0 && (
                    <KVRow label="Other Income" value={formatCurrency(is?.totalOtherIncome ?? 0)} />
                  )}
                  <KVRow label="Operating Expenses" value={formatCurrency(is?.totalOperatingExpenses ?? 0)} />
                  <KVRow label="Operating Profit" value={formatCurrency(is?.operatingProfit ?? 0)} bold />
                  {(is?.totalOtherExpenses ?? 0) !== 0 && (
                    <KVRow label="Other Expenses" value={formatCurrency(is?.totalOtherExpenses ?? 0)} />
                  )}
                  <KVRow label="Net Profit" value={formatCurrency(is?.netProfit ?? 0)} bold />
    </>
  );
}
