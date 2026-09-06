import { useCallback } from 'react';
import { ChartFrame } from './ChartFrame';
import type { ChartPalette } from './chartTypes';
import { buildCashPositionOption, type CashPositionPoint } from './cashPositionOption';

export function CashPositionChart({ points }: { points: CashPositionPoint[] }) {
  const build = useCallback(
    (p: ChartPalette) => (points.length === 0 ? null : buildCashPositionOption(points, p)),
    [points],
  );
  return (
    <ChartFrame title="Cash position" unit="Rand, as at period end" height={220}
      unavailable="No balances for this period.">
      {build}
    </ChartFrame>
  );
}
