import { useCallback } from 'react';
import { ChartFrame } from './ChartFrame';
import type { ChartPalette } from './chartTypes';
import { buildCashFlowSankeyOption, canRenderSankey, type CashFlowReport } from './sankeyOption';

export function CashFlowSankey({
  report, height = 340,
}: { report: CashFlowReport; height?: number }) {
  const build = useCallback(
    (p: ChartPalette) => (canRenderSankey(report) ? buildCashFlowSankeyOption(report, p) : null),
    [report],
  );
  // Two different reasons produce no chart, and they are not the same fact
  // about the period. Saying "negative balance" over a period in which
  // nothing moved would be wrong, and the reverse hides an overdraft.
  const unavailable = report.opening_cash < 0 || report.closing_cash < 0
    ? 'The cash balance is negative in this period, so the flows cannot be drawn without misstating the position. The statement below carries the figures.'
    : 'No cash moved in this period, so there are no flows to draw.';

  return (
    <ChartFrame
      title="Cash flow"
      unit="Rand, selected period"
      height={height}
      unavailable={unavailable}
    >
      {build}
    </ChartFrame>
  );
}
