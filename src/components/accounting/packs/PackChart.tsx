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
}

export function PackChart({ option, height = 320 }: PackChartProps) {
  return (
    <div data-pack-chart className="w-full">
      <EChartClient option={option} height={height} renderer="svg" />
    </div>
  );
}
