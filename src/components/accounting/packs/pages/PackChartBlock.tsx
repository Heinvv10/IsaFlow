/**
 * A pack chart on a fixed page: the pre-rendered SVG the model carries,
 * inlined at the height the model asked for.
 *
 * NOT `PackChart.tsx`. That one hands an ECharts option to `EChartClient`
 * and lets the browser draw it after hydration — a race the readiness gate
 * cannot see, which is exactly what `renderChartSvg` exists to remove. Here
 * the markup already exists by the time React runs.
 *
 * `data-pack-chart` is the attribute `usePrintReady` counts `<svg>` elements
 * under before it lets the transport photograph the page, so it goes on the
 * wrapper of every chart INCLUDING each small-multiples panel —
 * `countPageModelCharts` counts panels one by one, so a single wrapper
 * around the whole panel row would leave the gate waiting for charts it can
 * never find.
 *
 * The `dangerouslySetInnerHTML` is a sink for a `TrustedChartSvg` and does
 * NOT re-scan the string, for the reason `KpiTileWithSparkline` states: the
 * guards ran in `renderChartSvg`, which throws rather than returning unsafe
 * markup, and a second scan here would check shape rather than origin.
 */
import type { PackChartSpec } from '@/modules/accounting/services/packs/pages/packPageModel';

export interface PackChartBlockProps {
  chart: PackChartSpec;
}

export function PackChartBlock({ chart }: PackChartBlockProps) {
  return (
    <figure data-pack-chart className="pack-chart" style={{ height: `${chart.heightMm}mm` }}>
      {/* A message, not a category label — same rule as a page title, and it
       *  is the caption a reader reads before the marks. */}
      <figcaption className="pack-chart-title">{chart.title}</figcaption>
      <div className="pack-chart-svg" dangerouslySetInnerHTML={{ __html: chart.svg }} />
    </figure>
  );
}

export interface PackSmallMultiplesProps {
  panels: PackChartSpec[];
}

export function PackSmallMultiples({ panels }: PackSmallMultiplesProps) {
  return (
    <div className="pack-small-multiples">
      {panels.map((panel) => (
        <PackChartBlock key={panel.id} chart={panel} />
      ))}
    </div>
  );
}
