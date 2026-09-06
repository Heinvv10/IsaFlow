/**
 * ECharts module registry. Import `echarts` from here rather than the
 * package root — `echarts/core` plus explicit `use()` registration keeps
 * the bundle to only the chart types and renderers this app needs, instead
 * of the full echarts bundle.
 *
 * Loading: in the BROWSER this pulls in DOM/canvas code, so React callers
 * must load it through `next/dynamic` with `ssr: false` (see `EChart.tsx`).
 * It is nonetheless importable in plain Node for headless SVG rendering —
 * `echarts.init(null, null, { renderer: 'svg', ssr: true })` touches no DOM.
 * That is the print path; see `src/lib/charts/ssrSvg.ts`.
 */
import * as echarts from 'echarts/core';
import { BarChart, LineChart, CustomChart, SankeyChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  MarkLineComponent,
  TitleComponent,
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
  TitleComponent,
  SVGRenderer,
  CanvasRenderer,
]);

export { echarts };
