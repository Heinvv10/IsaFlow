/**
 * Entity summary table for the Group Dashboard.
 */

interface EntitySummary {
  companyId: string;
  companyName: string;
  revenue: number;
  expenses: number;
  netProfit: number;
  cashPosition: number;
}

interface Totals {
  revenue: number;
  expenses: number;
  netProfit: number;
  cashPosition: number;
}

const fmtCurrency = (n: number) =>
  'R ' + new Intl.NumberFormat('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

interface Props {
  entities: EntitySummary[];
  totals: Totals;
}

export function GroupEntityTable({ entities, totals }: Props) {
  return (
    <div className="bg-[var(--ff-bg-secondary)] rounded-lg border border-[var(--ff-border-light)] overflow-hidden">
      <div className="px-5 py-4 border-b border-[var(--ff-border-light)]">
        <h2 className="text-sm font-semibold text-[var(--ff-text-primary)]">Entity Summary</h2>
        <p className="text-xs text-[var(--ff-text-tertiary)] mt-0.5">Financial overview per company in the group</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--ff-border-light)]">
              {['Company Name', 'Revenue', 'Expenses', 'Net Profit', 'Cash Position'].map((h) => (
                <th
                  key={h}
                  className={`${h === 'Company Name' ? 'text-left' : 'text-right'} px-5 py-3 text-xs font-medium uppercase tracking-wider text-[var(--ff-text-secondary)]`}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {entities.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-8 text-center text-[var(--ff-text-tertiary)]">
                  No entities in this group yet.
                </td>
              </tr>
            ) : (
              <>
                {entities.map(entity => (
                  <tr key={entity.companyId} className="border-b border-[var(--ff-border-light)] hover:bg-[var(--ff-surface-primary)] transition-colors">
                    <td className="px-5 py-3 font-medium text-[var(--ff-text-primary)]">{entity.companyName}</td>
                    <td className="px-5 py-3 text-right text-[var(--ff-text-primary)] tabular-nums">{fmtCurrency(entity.revenue)}</td>
                    <td className="px-5 py-3 text-right text-[var(--ff-text-primary)] tabular-nums">{fmtCurrency(entity.expenses)}</td>
                    <td className={`px-5 py-3 text-right font-medium tabular-nums ${entity.netProfit >= 0 ? 'text-teal-500' : 'text-rose-500'}`}>
                      {fmtCurrency(entity.netProfit)}
                    </td>
                    <td className="px-5 py-3 text-right text-[var(--ff-text-primary)] tabular-nums">{fmtCurrency(entity.cashPosition)}</td>
                  </tr>
                ))}
                <tr className="bg-[var(--ff-surface-primary)] font-semibold">
                  <td className="px-5 py-3 text-[var(--ff-text-primary)]">Total</td>
                  <td className="px-5 py-3 text-right text-[var(--ff-text-primary)] tabular-nums">{fmtCurrency(totals.revenue)}</td>
                  <td className="px-5 py-3 text-right text-[var(--ff-text-primary)] tabular-nums">{fmtCurrency(totals.expenses)}</td>
                  <td className={`px-5 py-3 text-right tabular-nums ${totals.netProfit >= 0 ? 'text-teal-500' : 'text-rose-500'}`}>
                    {fmtCurrency(totals.netProfit)}
                  </td>
                  <td className="px-5 py-3 text-right text-[var(--ff-text-primary)] tabular-nums">{fmtCurrency(totals.cashPosition)}</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
