/**
 * The colours a chart is allowed to use, resolved once per page from the
 * `--ff-*` tokens through WS-E's `buildTheme`.
 *
 * Option builders take a palette as an ARGUMENT rather than reading
 * `document` themselves: that is what makes them pure, testable under the
 * node vitest config, and safe to call during SSR.
 */
import type { EChartsTheme } from '@/lib/charts/theme';

export interface ChartPalette {
  ink: string;
  prior: string;
  plan: string;
  fav: string;
  unfav: string;
  figFont: string;
  axisLine: string;
  axisLabel: string;
}

/** Used during SSR and in tests. Same values as the theme's own fallbacks. */
export const DEFAULT_PALETTE: ChartPalette = {
  ink: '#15202b',
  prior: '#c9d0cc',
  plan: '#8a94a0',
  fav: '#1f7a4d',
  unfav: '#b23a3a',
  figFont: 'ui-monospace, monospace',
  axisLine: '#e5e7eb',
  axisLabel: '#9ca3af',
};

export function paletteFromTheme(theme: EChartsTheme): ChartPalette {
  return {
    ink: theme.color[0],
    prior: theme.color[1],
    plan: theme.color[2],
    fav: theme.favColor,
    unfav: theme.unfavColor,
    figFont: theme.textStyle.fontFamily,
    axisLine: theme.categoryAxis.axisLine.lineStyle.color,
    axisLabel: theme.categoryAxis.axisLabel.color,
  };
}
