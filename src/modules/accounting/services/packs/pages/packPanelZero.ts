/**
 * A PAGE-10 PANEL'S VALUE LABELS: ITS ZERO LINE NAMED, AND ZERO AS THE DASH.
 *
 * A panel labels the two ends of its scale and nothing between
 * (`smallMultipleOption`'s `{ endpoints: true }`), and where the scale
 * crosses zero ECharts draws the category axis there, darker than the
 * gridlines. On the gross margin, net profit and cash panels that rule stood
 * between "1 908" and "(1 621)" with no figure on it, on the panels whose
 * question is which side of break-even they sit. It takes a label where it
 * stands a label's height of air clear of both end labels: at 11.6px v79's
 * "0.0%" sat on "(1 138.7%)", and nearer than that the end label already says
 * where zero is.
 *
 * And zero prints as the pack's dash on every panel, whatever its unit — the
 * rule page 12 states and `formatFigureText` keeps: "0.0%" and "0 days" were
 * two more ways of writing a measured nil.
 */
import type { EChartsCoreOption } from 'echarts/core';
import { PX_PER_MM } from '@/lib/charts/ssrSvg';
import { PANEL } from './packTrendPanelSet';

/** The panel's value labels are 8px type: one label's height of air between
 *  two of them, centred on their rules. */
const CLEAR_PX = 16;
const ZERO = '–';

export function panelAxisLabels(option: EChartsCoreOption, domain: { min: number; max: number }): EChartsCoreOption {
  const o = option as EChartsCoreOption & {
    grid: { top: number; bottom: number };
    yAxis: { axisLabel: Record<string, unknown> & { formatter?: (value: number) => string } };
  };
  const format = o.yAxis.axisLabel.formatter;
  const axisLabel = { ...o.yAxis.axisLabel, ...(format === undefined ? {} : { formatter: (value: number) => (value === 0 ? ZERO : format(value)) }) };
  const plotPx = Math.round(PANEL.heightMm * PX_PER_MM) - o.grid.top - o.grid.bottom;
  const fromTop = domain.max > domain.min ? (domain.max / (domain.max - domain.min)) * plotPx : 0;
  const zeroClear = domain.min < 0 && domain.max > 0 && fromTop >= CLEAR_PX && plotPx - fromTop >= CLEAR_PX;
  return { ...o, yAxis: { ...o.yAxis, axisLabel: zeroClear ? { ...axisLabel, customValues: [domain.min, 0, domain.max] } : axisLabel } };
}
