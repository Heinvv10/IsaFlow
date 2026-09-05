import dynamic from 'next/dynamic';

/**
 * SSR-safe entry point for `EChart`. ECharts touches `document`/canvas at
 * import time (see `src/lib/charts/echarts.ts`), so pages must import this
 * module — never `EChart.tsx` directly — to keep the server bundle clean.
 */
export const EChartClient = dynamic(() => import('./EChart').then((m) => m.EChart), {
  ssr: false,
});
