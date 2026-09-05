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
  return (
    <ChartFrame
      title="Cash flow"
      unit="Rand, selected period"
      height={height}
      unavailable="The cash balance is negative in this period, so the flows cannot be drawn without misstating the position. The statement below carries the figures."
    >
      {build}
    </ChartFrame>
  );
}
