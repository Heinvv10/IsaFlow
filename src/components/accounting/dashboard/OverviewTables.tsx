/**
 * OverviewTables — Top customers, top expenses, AR/AP aging donuts
 */

import dynamic from 'next/dynamic';
import { formatMoney } from '@/lib/money/formatMoney';

const PieChart = dynamic(() => import('recharts').then(m => m.PieChart), { ssr: false });
const Pie = dynamic(() => import('recharts').then(m => m.Pie), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then(m => m.Tooltip), { ssr: false });
const ResponsiveContainer = dynamic(() => import('recharts').then(m => m.ResponsiveContainer), { ssr: false });

/**
 * The two Top 5 tables are wider than a 390 px card (an exact amount, "R 6 376 148.65", does not wrap or
 * truncate): they scroll sideways inside a labelled, focusable region, so every column stays reachable
 * and the page itself never scrolls.
 */
const SCROLL_REGION = 'overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-500';

/** One per segment: Current, 1–30, 31–60, 61–90, 90+, Disputed (reports/dashboardOpenBook AGING_BREAKDOWN_LABELS). */
const AGING_COLORS = ['#14b8a6', '#fbbf24', '#f97316', '#f43f5e', '#9f1239', '#8b5cf6'];
/** A zero Disputed segment is left out of the legend (AP has no disputes); a zero age bucket is not. */
const shownInLegend = (b: AgingBucket): boolean => b.name !== 'Disputed' || b.value !== 0;
const isDisputed = (b: AgingBucket): boolean => b.name === 'Disputed' && b.value > 0;
/**
 * Each slice carries its own fill. Pie reads per-slice colour from <Cell>
 * children it recognises by type, and a next/dynamic-wrapped Cell is not one,
 * so every slice drew in Pie's default grey (#808080).
 */
export const agingSlices = (buckets: AgingBucket[]) =>
  buckets.map((b, i) => ({ ...b, fill: AGING_COLORS[i % AGING_COLORS.length]! }));

function fmtCurrency(n: number): string {
  return formatMoney(n);
}

interface AgingBucket { name: string; value: number }
interface TopCustomer { name: string; revenue: number; invoiceCount: number }
interface TopExpense { accountName: string; total: number; percentOfExpenses: number }

interface Props {
  topCustomers: TopCustomer[];
  topExpenses: TopExpense[];
  arAging: AgingBucket[];
  apAging: AgingBucket[];
}

export function OverviewTables({ topCustomers, topExpenses, arAging, apAging }: Props) {
  return (
    <>
      {/* Top 5 tables */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
          <div className="px-5 py-3 border-b border-[var(--ff-border-light)]">
            <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Top 5 Customers by Revenue</h3>
          </div>
          {topCustomers.length > 0 ? (
            <div role="region" aria-label="Top 5 Customers by Revenue, table" tabIndex={0} className={SCROLL_REGION}>
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)]">
                  <th className="px-3 sm:px-5 py-2 text-left text-xs font-medium uppercase text-[var(--ff-text-secondary)]">Customer</th>
                  <th className="px-3 sm:px-5 py-2 text-right text-xs font-medium uppercase text-[var(--ff-text-secondary)]">Revenue</th>
                  <th className="px-3 sm:px-5 py-2 text-right text-xs font-medium uppercase text-[var(--ff-text-secondary)]">Invoices</th>
                </tr>
              </thead>
              <tbody>
                {topCustomers.map((c, i) => (
                  <tr key={i} className="border-b border-[var(--ff-border-light)]/50 last:border-0">
                    <td className="px-3 sm:px-5 py-2.5 text-sm text-[var(--ff-text-primary)] truncate max-w-[140px] sm:max-w-[200px]">{c.name}</td>
                    <td className="px-3 sm:px-5 py-2.5 text-sm text-right tabular-nums whitespace-nowrap text-teal-500">{fmtCurrency(c.revenue)}</td>
                    <td className="px-3 sm:px-5 py-2.5 text-sm text-right whitespace-nowrap text-[var(--ff-text-secondary)]">{c.invoiceCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ) : (
            <div className="p-8 text-center text-sm text-[var(--ff-text-tertiary)]">No customer data</div>
          )}
        </div>

        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
          <div className="px-5 py-3 border-b border-[var(--ff-border-light)]">
            <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Top 5 Expense Categories</h3>
          </div>
          {topExpenses.length > 0 ? (
            <div role="region" aria-label="Top 5 Expense Categories, table" tabIndex={0} className={SCROLL_REGION}>
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)]">
                  <th className="px-3 sm:px-5 py-2 text-left text-xs font-medium uppercase text-[var(--ff-text-secondary)]">Account</th>
                  <th className="px-3 sm:px-5 py-2 text-right text-xs font-medium uppercase text-[var(--ff-text-secondary)]">Total</th>
                  <th className="px-3 sm:px-5 py-2 text-right text-xs font-medium uppercase text-[var(--ff-text-secondary)]">%</th>
                </tr>
              </thead>
              <tbody>
                {topExpenses.map((e, i) => (
                  <tr key={i} className="border-b border-[var(--ff-border-light)]/50 last:border-0">
                    <td className="px-3 sm:px-5 py-2.5 text-sm text-[var(--ff-text-primary)] truncate max-w-[140px] sm:max-w-[200px]">{e.accountName}</td>
                    <td className="px-3 sm:px-5 py-2.5 text-sm text-right tabular-nums whitespace-nowrap text-rose-600 dark:text-rose-400">{fmtCurrency(e.total)}</td>
                    <td className="px-3 sm:px-5 py-2.5 text-sm text-right whitespace-nowrap text-[var(--ff-text-secondary)]">{e.percentOfExpenses.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
          ) : (
            <div className="p-8 text-center text-sm text-[var(--ff-text-tertiary)]">No expense data</div>
          )}
        </div>
      </div>

      {/* AR / AP Aging Donuts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {([['arAging', arAging, 'AR Aging', 'No outstanding AR', 'AR Age Analysis'], ['apAging', apAging, 'AP Aging', 'No outstanding AP', 'AP Age Analysis']] as const).map(([key, buckets, title, emptyMsg, report]) => (
          <div key={key} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
            <h3 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">{title}</h3>
            {buckets.some(b => b.value > 0) ? (
              <div className="flex flex-col items-center gap-4 sm:flex-row">
                {/* Full width below sm: half of a 390 px card is narrower than the 160 px donut, which clipped it. */}
                <div data-testid={`${key}-donut`} className="w-full shrink-0 sm:w-1/2">
                <ResponsiveContainer width="100%" height={200}>
                  <PieChart>
                    <Pie data={agingSlices(buckets)} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2} />
                    <Tooltip contentStyle={{ backgroundColor: 'var(--ff-bg-secondary)', border: '1px solid var(--ff-border-light)', borderRadius: '8px', color: 'var(--ff-text-primary)' }} formatter={(value) => [fmtCurrency(Number(value)), '']} />
                  </PieChart>
                </ResponsiveContainer>
                </div>
                <div className="w-full flex-1 space-y-2">
                  {buckets.map((bucket, i) => shownInLegend(bucket) && (
                    <div key={i} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: AGING_COLORS[i] }} />
                        <span className="text-xs text-[var(--ff-text-secondary)]">{bucket.name}</span>
                      </div>
                      <span className="text-xs tabular-nums text-[var(--ff-text-primary)]">{fmtCurrency(bucket.value)}</span>
                    </div>
                  ))}
                  {buckets.some(isDisputed) && (
                    // The report keeps a disputed amount in its age bucket; this donut takes it out.
                    <p className="pt-1 text-xs text-[var(--ff-text-tertiary)]">
                      Disputed amounts are shown separately here. On the {report} report they stay inside their age bucket.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center h-[200px] text-[var(--ff-text-tertiary)] text-sm">{emptyMsg}</div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
