import { useCallback } from 'react';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { ChartFrame } from './ChartFrame';
import type { ChartPalette } from './chartTypes';
import { buildWaterfallOption } from './waterfallOption';

export function ProfitWaterfall({
  steps, title = 'Profit bridge', unit = 'Rand, selected period', height = 300, summary, unavailable = 'Nothing posted in this period.',
}: { steps: WaterfallStep[]; title?: string; unit?: string; height?: number; summary?: string; unavailable?: string }) {
  const build = useCallback(
    (p: ChartPalette) => (steps.length === 0 ? null : buildWaterfallOption(steps, p)),
    [steps],
  );
  return (
    <ChartFrame title={title} unit={unit} height={height} unavailable={unavailable} summary={summary}>
      {build}
    </ChartFrame>
  );
}
