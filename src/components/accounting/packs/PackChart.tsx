/**
 * A pack chart. Always the SVG renderer: the readiness gate counts <svg>
 * elements, and an SVG in the PDF stays sharp at print resolution where a
 * canvas bitmap does not.
 */
import type { EChartsCoreOption } from 'echarts/core';
import { EChartClient } from '@/components/charts/EChartClient';

export interface PackChartProps {
  option: EChartsCoreOption;
  height?: number;
  /** A fixed width in pixels, for a chart whose option was laid out for one
   *  known rectangle. Absent, the chart takes its container's width. */
  width?: number;
}

export function PackChart({ option, height = 320, width }: PackChartProps) {
  return (
    <div data-pack-chart className={width === undefined ? 'w-full' : undefined} style={width === undefined ? undefined : { width }}>
      <EChartClient option={option} height={height} renderer="svg" />
    </div>
  );
}
