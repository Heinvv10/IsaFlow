import { useCallback } from 'react';
import { ChartFrame } from './ChartFrame';
import type { ChartPalette } from './chartTypes';
import { buildSmallMultiplesOption, type TrendPanel } from './smallMultiplesOption';

export function SmallMultiples({
  panels, months, columns = 3, title = 'Twelve months by account', height,
}: {
  panels: TrendPanel[];
  months: string[];
  columns?: number;
  title?: string;
  /** Fixed frame height. Given, the grid fills it instead of sizing itself
   *  to the panel count — a presentation slide has the room and a grid
   *  occupying the top third of a projected screen wastes it. */
  height?: number;
}) {
  const build = useCallback(
    (p: ChartPalette) =>
      panels.length === 0 ? null : buildSmallMultiplesOption(panels, months, p, { columns }),
    [panels, months, columns],
  );
  const rows = Math.ceil(panels.length / columns) || 1;
  return (
    <ChartFrame
      title={title}
      unit="Rand per month, all panels on one scale"
      height={height ?? rows * 130 + 40}
      unavailable="No account has twelve months of posted movement yet."
    >
      {build}
    </ChartFrame>
  );
}
