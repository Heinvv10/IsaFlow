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
import type { CSSProperties } from 'react';
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

/**
 * THE PANELS' PLOT BOXES ARE ONE HEIGHT, AND THE CAPTIONS TAKE WHAT THEY NEED.
 *
 * A small-multiples group makes a claim its captions can break. The four money
 * panels share one y-domain in the SVG's user space — but `.pack-chart-svg`
 * used to take `flex: 1` inside a fixed-height figure, so a panel whose title
 * wrapped to two lines got a shorter plot box and painted the same rand amount
 * shorter than the panel beside it. On the live demo pack that was 123.3px
 * against 142.0px, 0.74275 page pixels per user unit against 0.85523: a
 * thirteen-percent difference on a page that says the scale is shared.
 *
 * So `heightMm` on a PANEL is the plot box, not the figure, and the figure
 * grows with its caption. See `packPrint.css` and `blockMm`'s `smallMultiples`
 * case, which charges each row for its tallest caption.
 */
export function PackSmallMultiples({ panels }: PackSmallMultiplesProps) {
  return (
    <div className="pack-small-multiples">
      {panels.map((panel) => (
        <figure
          key={panel.id}
          data-pack-chart
          className="pack-chart"
          style={{ '--pack-panel-plot-mm': `${panel.heightMm}mm` } as CSSProperties}
        >
          <figcaption className="pack-chart-title">{panel.title}</figcaption>
          <div className="pack-chart-svg" dangerouslySetInnerHTML={{ __html: panel.svg }} />
        </figure>
      ))}
    </div>
  );
}
