/**
 * ECharts module registry. Import `echarts` from here rather than the
 * package root — `echarts/core` plus explicit `use()` registration keeps
 * the bundle to only the chart types and renderers this app needs, instead
 * of the full echarts bundle.
 *
 * Client-only: importing this module pulls in DOM/canvas code, so callers
 * must load it through `next/dynamic` with `ssr: false` (see `EChart.tsx`).
 */
import * as echarts from 'echarts/core';
import { BarChart, LineChart, CustomChart, SankeyChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
} from 'echarts/components';
import { SVGRenderer, CanvasRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  LineChart,
  CustomChart,
  SankeyChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  SVGRenderer,
  CanvasRenderer,
]);

export { echarts };
