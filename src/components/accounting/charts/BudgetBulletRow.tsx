import { useCallback } from 'react';
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';
import { ChartFrame } from './ChartFrame';
import type { ChartPalette } from './chartTypes';
import { buildBudgetBulletOption } from './bulletOption';

export function BudgetBulletRow({
  lines, limit = 10, height,
}: { lines: BudgetVsActualLine[]; limit?: number; height?: number }) {
  const build = useCallback(
    (p: ChartPalette) => (lines.length === 0 ? null : buildBudgetBulletOption(lines, p, { limit })),
    [lines, limit],
  );
  return (
    <ChartFrame
      title="Budget variance"
      unit="Rand, selected period. Bar = actual, outline = budget."
      height={height ?? Math.max(160, Math.min(lines.length, limit) * 34 + 40)}
      unavailable="No account carries a budget for this period."
    >
      {build}
    </ChartFrame>
  );
}
