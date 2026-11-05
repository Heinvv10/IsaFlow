/**
 * The budget a bill hits, per slice (budgets P5-2 approve dialog, spec §5): account, slice, month,
 * budget, actual, committed, remaining and this bill. Below `sm` each line is a stacked card (account ·
 * slice · month, then label-value rows) so nothing scrolls off a 390 px screen; from `sm` up, a table.
 * Colour (IBCS unfavourable, `ibcs.varianceColor`): "This bill" on an over line (the over value), and
 * Remaining only when it is negative. A slice with no budget says so and is never over. A line outside every
 * budgeted slice of a budgeted account (P5-2b, `offSlice`) says "Not in a budgeted slice", in the unfavourable
 * colour with its amount: the check acts on it as on an over line.
 */
import type { ReactNode } from 'react';
import { useChartPalette } from '@/components/accounting/charts/ChartFrame';
import { varianceColor } from '@/components/accounting/charts/ibcs';
import { formatCurrency } from '@/utils/formatters';
import type { BudgetCheckLine } from '@/modules/accounting/services/budgets/budgetCheckTypes';

const NUM = 'px-2 py-1.5 text-right tabular-nums whitespace-nowrap';

const keyOf = (l: BudgetCheckLine) => `${l.glAccountId}|${l.cc1Id ?? ''}|${l.cc2Id ?? ''}|${l.buId ?? ''}|${l.month}`;
const sliceOf = (l: BudgetCheckLine) => (l.unassigned ? 'Unassigned' : l.sliceLabel || 'Company');
const OFF_SLICE_LABEL = 'Not in a budgeted slice';
const Marker = ({ l }: { l: BudgetCheckLine }) => (l.over ? <span className="sr-only"> (over budget)</span>
  : l.offSlice ? <span className="sr-only"> (not in a budgeted slice)</span> : null);

export function BudgetLinesTable({ lines, documentNoun = 'This bill' }: { lines: readonly BudgetCheckLine[]; documentNoun?: string }) {
  const palette = useChartPalette();
  const unfav = varianceColor(false, palette);
  if (lines.length === 0) return <p className="text-sm text-[var(--ff-text-secondary)]">No lines to check.</p>;
  const red = (on: boolean) => (on && unfav ? { color: unfav, fontWeight: 600 } : undefined);
  const remainingStyle = (l: BudgetCheckLine) => red(l.remaining !== null && l.remaining < 0);
  const billStyle = (l: BudgetCheckLine) => red(l.over || l.offSlice);
  const noBudgetText = (l: BudgetCheckLine) => (l.offSlice
    ? <span data-cell="off-slice" style={red(true)}>{OFF_SLICE_LABEL}</span>
    : <span className="text-[var(--ff-text-tertiary)]">No budget</span>);

  return (
    <>
      <ul data-testid="budget-lines-cards" className="sm:hidden space-y-2">
        {lines.map((l) => (
          <li key={keyOf(l)} className="rounded-lg border border-[var(--ff-border-light)] p-2 text-xs text-[var(--ff-text-primary)]">
            <p className="font-medium mb-1">{[l.accountLabel || '—', sliceOf(l), l.month].join(' · ')}</p>
            <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5">
              {l.budget === null ? (
                <CardRow label="Budget">{noBudgetText(l)}</CardRow>
              ) : (
                <>
                  <CardRow label="Budget">{formatCurrency(l.budget)}</CardRow>
                  <CardRow label="Actual">{formatCurrency(l.actual)}</CardRow>
                  <CardRow label="Committed">{formatCurrency(l.committed)}</CardRow>
                  <CardRow label="Remaining"><span data-cell="remaining" style={remainingStyle(l)}>{formatCurrency(l.remaining ?? 0)}</span></CardRow>
                </>
              )}
              <CardRow label={documentNoun}><span style={billStyle(l)}>{formatCurrency(l.amount)}</span><Marker l={l} /></CardRow>
            </dl>
          </li>
        ))}
      </ul>
      <div data-testid="budget-lines-table" className="hidden sm:block overflow-x-auto">
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
            {lines.map((l) => (
              <tr key={keyOf(l)} className="border-b border-[var(--ff-border-light)] last:border-0 text-[var(--ff-text-primary)]">
                <td className="px-2 py-1.5">{l.accountLabel || '—'}</td>
                <td className="px-2 py-1.5">{sliceOf(l)}</td>
                <td className="px-2 py-1.5 whitespace-nowrap">{l.month}</td>
                {l.budget === null ? (
                  <td className={NUM} colSpan={4}>{noBudgetText(l)}</td>
                ) : (
                  <>
                    <td className={NUM}>{formatCurrency(l.budget)}</td>
                    <td className={NUM}>{formatCurrency(l.actual)}</td>
                    <td className={NUM}>{formatCurrency(l.committed)}</td>
                    <td className={NUM} data-cell="remaining" style={remainingStyle(l)}>{formatCurrency(l.remaining ?? 0)}</td>
                  </>
                )}
                <td className={NUM}><span style={billStyle(l)}>{formatCurrency(l.amount)}</span><Marker l={l} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function CardRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-[var(--ff-text-tertiary)]">{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
    </>
  );
}
