/**
 * OverviewTables — Top customers, top expenses, AR/AP aging donuts
 */

import dynamic from 'next/dynamic';

const PieChart = dynamic(() => import('recharts').then(m => m.PieChart), { ssr: false });
const Pie = dynamic(() => import('recharts').then(m => m.Pie), { ssr: false });
const Cell = dynamic(() => import('recharts').then(m => m.Cell), { ssr: false });
const Tooltip = dynamic(() => import('recharts').then(m => m.Tooltip), { ssr: false });
const ResponsiveContainer = dynamic(() => import('recharts').then(m => m.ResponsiveContainer), { ssr: false });

const AGING_COLORS = ['#14b8a6', '#fbbf24', '#f97316', '#f43f5e'];

function fmtCurrency(n: number): string {
  return 'R ' + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
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
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)]">
                  <th className="px-5 py-2 text-left text-xs font-medium uppercase text-[var(--ff-text-secondary)]">Customer</th>
                  <th className="px-5 py-2 text-right text-xs font-medium uppercase text-[var(--ff-text-secondary)]">Revenue</th>
                  <th className="px-5 py-2 text-right text-xs font-medium uppercase text-[var(--ff-text-secondary)]">Invoices</th>
                </tr>
              </thead>
              <tbody>
                {topCustomers.map((c, i) => (
                  <tr key={i} className="border-b border-[var(--ff-border-light)]/50 last:border-0">
                    <td className="px-5 py-2.5 text-sm text-[var(--ff-text-primary)] truncate max-w-[200px]">{c.name}</td>
                    <td className="px-5 py-2.5 text-sm text-right font-mono text-teal-500">{fmtCurrency(c.revenue)}</td>
                    <td className="px-5 py-2.5 text-sm text-right text-[var(--ff-text-secondary)]">{c.invoiceCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="p-8 text-center text-sm text-[var(--ff-text-tertiary)]">No customer data</div>
          )}
        </div>

        <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
          <div className="px-5 py-3 border-b border-[var(--ff-border-light)]">
            <h3 className="text-sm font-semibold text-[var(--ff-text-primary)]">Top 5 Expense Categories</h3>
          </div>
          {topExpenses.length > 0 ? (
            <table className="w-full">
              <thead>
                <tr className="border-b border-[var(--ff-border-light)]">
                  <th className="px-5 py-2 text-left text-xs font-medium uppercase text-[var(--ff-text-secondary)]">Account</th>
                  <th className="px-5 py-2 text-right text-xs font-medium uppercase text-[var(--ff-text-secondary)]">Total</th>
                  <th className="px-5 py-2 text-right text-xs font-medium uppercase text-[var(--ff-text-secondary)]">%</th>
                </tr>
              </thead>
              <tbody>
                {topExpenses.map((e, i) => (
                  <tr key={i} className="border-b border-[var(--ff-border-light)]/50 last:border-0">
                    <td className="px-5 py-2.5 text-sm text-[var(--ff-text-primary)] truncate max-w-[200px]">{e.accountName}</td>
                    <td className="px-5 py-2.5 text-sm text-right font-mono text-rose-500">{fmtCurrency(e.total)}</td>
                    <td className="px-5 py-2.5 text-sm text-right text-[var(--ff-text-secondary)]">{e.percentOfExpenses.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="p-8 text-center text-sm text-[var(--ff-text-tertiary)]">No expense data</div>
          )}
        </div>
      </div>

      {/* AR / AP Aging Donuts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {([['arAging', arAging, 'AR Aging', 'No outstanding AR'], ['apAging', apAging, 'AP Aging', 'No outstanding AP']] as const).map(([key, buckets, title, emptyMsg]) => (
          <div key={key} className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] p-5">
            <h3 className="text-sm font-semibold text-[var(--ff-text-primary)] mb-4">{title}</h3>
            {buckets.some(b => b.value > 0) ? (
              <div className="flex items-center gap-4">
                <ResponsiveContainer width="50%" height={200}>
                  <PieChart>
                    <Pie data={buckets} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={2}>
                      {buckets.map((_entry, index) => (
                        <Cell key={`${key}-${index}`} fill={AGING_COLORS[index % AGING_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ backgroundColor: 'var(--ff-bg-secondary)', border: '1px solid var(--ff-border-light)', borderRadius: '8px', color: 'var(--ff-text-primary)' }} formatter={(value) => [fmtCurrency(Number(value)), '']} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 space-y-2">
                  {buckets.map((bucket, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <div className="w-3 h-3 rounded-full" style={{ backgroundColor: AGING_COLORS[i] }} />
                        <span className="text-xs text-[var(--ff-text-secondary)]">{bucket.name}</span>
                      </div>
                      <span className="text-xs font-mono text-[var(--ff-text-primary)]">{fmtCurrency(bucket.value)}</span>
                    </div>
                  ))}
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
