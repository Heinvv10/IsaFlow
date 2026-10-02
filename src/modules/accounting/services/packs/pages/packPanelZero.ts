/**
 * A PAGE-10 PANEL'S ZERO LINE, LABELLED.
 *
 * A panel labels the two ends of its scale and nothing between
 * (`smallMultipleOption`'s `{ endpoints: true }`), and where the scale
 * crosses zero ECharts draws the category axis there, darker than the
 * gridlines. On the gross margin, net profit and cash panels that rule stood
 * between "1 908" and "(1 621)" with no figure on it, on the panels whose
 * question is which side of break-even they sit. It takes a label in the
 * panel's own unit, where it stands clear of both end labels; nearer than
 * that, the end label it would meet already says where zero is.
 */
import type { EChartsCoreOption } from 'echarts/core';
import { PX_PER_MM } from '@/lib/charts/ssrSvg';
import { PANEL } from './packTrendPanelSet';

/** Two of the panel's 8px value labels, centred on their rules, overlap
 *  nearer than this. */
const CLEAR_PX = 9;

export function withZeroLabelled(option: EChartsCoreOption, domain: { min: number; max: number }): EChartsCoreOption {
  if (!(domain.min < 0 && domain.max > 0)) return option;
  const o = option as EChartsCoreOption & { grid: { top: number; bottom: number }; yAxis: { axisLabel: Record<string, unknown> } };
  const plotPx = Math.round(PANEL.heightMm * PX_PER_MM) - o.grid.top - o.grid.bottom;
  const fromTop = (domain.max / (domain.max - domain.min)) * plotPx;
  if (fromTop < CLEAR_PX || plotPx - fromTop < CLEAR_PX) return option;
  return { ...o, yAxis: { ...o.yAxis, axisLabel: { ...o.yAxis.axisLabel, customValues: [domain.min, 0, domain.max] } } };
}
