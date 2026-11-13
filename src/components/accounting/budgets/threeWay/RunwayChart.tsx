/**
 * The runway chart of the version on screen (budgets P6 spec §8): closing cash per month, the minimum-cash line
 * and the months below zero shaded (`buildRunwayOption`). The figures are also stated in words for a screen
 * reader (ChartFrame's `summary`).
 */
import { useCallback } from 'react';
import { formatStatementFigure } from '@/lib/format/money';
import { ChartFrame } from '@/components/accounting/charts/ChartFrame';
import type { ChartPalette } from '@/components/accounting/charts/chartTypes';
import type { ThreeWayView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { buildRunwayOption } from './runwayOption';

const R = (cents: number): string => (cents === 0 ? 'R 0' : formatStatementFigure(cents / 100, { symbol: true }));

export function runwaySummary(view: ThreeWayView): string {
  const cash = view.cashFlow.direct.map((d) => d.closingCash);
  const { runway } = view;
  const below = runway.firstBelowMinimum ? `; first below the minimum of ${R(runway.minimumCash)} in ${runway.firstBelowMinimum}` : '';
  return `Closing cash ${R(cash[0] ?? 0)} in ${view.months[0] ?? ''} to ${R(cash[cash.length - 1] ?? 0)} in ${view.months[view.months.length - 1] ?? ''}; `
    + `lowest ${R(runway.minCash)} in ${runway.minCashMonth}${below}.`;
}

export function RunwayChart({ view }: { view: ThreeWayView }) {
  const option = useCallback((palette: ChartPalette) => buildRunwayOption({
    months: view.months,
    series: [{ name: view.version.name, cents: view.cashFlow.direct.map((d) => d.closingCash) }],
    minimumCashCents: view.runway.minimumCash,
  }, palette), [view]);
  return (
    <div data-testid="runway-chart">
      <ChartFrame title="Cash runway" unit="R, month-end closing cash" height={260} summary={runwaySummary(view)}>{option}</ChartFrame>
    </div>
  );
}
