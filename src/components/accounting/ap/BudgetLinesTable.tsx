/**
 * The budget a bill hits, per slice (budgets P5-2 approve dialog, spec §5): account, slice, month,
 * budget, actual, committed, remaining and this bill. An over line's remaining and amount take the
 * IBCS unfavourable colour (`ibcs.varianceColor`); a slice with no budget says so and is never over.
 */
import { useChartPalette } from '@/components/accounting/charts/ChartFrame';
import { varianceColor } from '@/components/accounting/charts/ibcs';
import { formatCurrency } from '@/utils/formatters';
import type { BudgetCheckLine } from '@/modules/accounting/services/budgets/budgetCheckTypes';

const NUM = 'px-2 py-1.5 text-right tabular-nums whitespace-nowrap';

export function BudgetLinesTable({ lines, documentNoun = 'This bill' }: { lines: readonly BudgetCheckLine[]; documentNoun?: string }) {
  const palette = useChartPalette();
  const unfav = varianceColor(false, palette);
  if (lines.length === 0) return <p className="text-sm text-[var(--ff-text-secondary)]">No lines to check.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-[var(--ff-text-tertiary)] border-b border-[var(--ff-border-light)]">
            <th scope="col" className="px-2 py-1.5 text-left font-medium">Account</th>
            <th scope="col" className="px-2 py-1.5 text-left font-medium">Slice</th>
            <th scope="col" className="px-2 py-1.5 text-left font-medium">Month</th>
            <th scope="col" className={`${NUM} font-medium`}>Budget</th>
            <th scope="col" className={`${NUM} font-medium`}>Actual</th>
            <th scope="col" className={`${NUM} font-medium`}>Committed</th>
            <th scope="col" className={`${NUM} font-medium`}>Remaining</th>
            <th scope="col" className={`${NUM} font-medium`}>{documentNoun}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const colour = l.over ? unfav : undefined;
            const key = `${l.glAccountId}|${l.cc1Id ?? ''}|${l.cc2Id ?? ''}|${l.buId ?? ''}|${l.month}`;
            return (
              <tr key={key} className="border-b border-[var(--ff-border-light)] last:border-0 text-[var(--ff-text-primary)]">
                <td className="px-2 py-1.5">{l.accountLabel || '—'}</td>
                <td className="px-2 py-1.5">{l.unassigned ? 'Unassigned' : l.sliceLabel || 'Company'}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">{l.month}</td>
                {l.budget === null ? (
                  <td className={`${NUM} text-[var(--ff-text-tertiary)]`} colSpan={4}>No budget</td>
                ) : (
                  <>
                    <td className={NUM}>{formatCurrency(l.budget)}</td>
                    <td className={NUM}>{formatCurrency(l.actual)}</td>
                    <td className={NUM}>{formatCurrency(l.committed)}</td>
                    <td className={NUM} style={colour ? { color: colour, fontWeight: 600 } : undefined}>{formatCurrency(l.remaining ?? 0)}</td>
                  </>
                )}
                <td className={NUM} style={colour ? { color: colour, fontWeight: 600 } : undefined}>
                  {formatCurrency(l.amount)}{l.over ? <span className="sr-only"> (over budget)</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
