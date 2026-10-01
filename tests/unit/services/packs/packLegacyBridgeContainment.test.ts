/**
 * THE ON-SCREEN PACK'S BRIDGE KEEPS ECHARTS' OWN LABEL CONTAINMENT.
 *
 * The exact-plot layout measures category names and ticks in the print face,
 * IBM Plex Sans, and switches ECharts' containment off. The screen view's
 * theme sets chart text in IBM Plex Mono, wider, so with the layout applied a
 * tick like "(4 000 000)" ran 7–14px off the left edge and "Operating
 * Expenses" past the bottom. Rendered here with that theme registered, as the
 * screen does, and measured in Plex Mono — a fixed 0.6em advance, so the
 * width is exact: every axis label lies inside the SVG, and every figure on
 * the plot.
 */
import { describe, expect, it } from 'vitest';
import { echarts } from '@/lib/charts/echarts';
import { buildTheme } from '@/lib/charts/theme';
import { legacyWaterfallOption } from '@/components/accounting/packs/PackSectionView';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import { clipRect, figures, outsideClip } from './support/bridgeSvg';

const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const MONO_EM = 0.6;
const PX = 12;
const WIDTH = 900;
const HEIGHT = 320;

const bridge = (rev: number, net: number): WaterfallStep[] => [
  { label: 'Revenue', start: 0, end: rev, value: rev, isSubtotal: false, color: 'green' },
  { label: 'Cost of Sales', start: rev, end: rev * 0.6, value: -rev * 0.4, isSubtotal: false, color: 'red' },
  { label: 'Gross Profit', start: 0, end: rev * 0.6, value: rev * 0.6, isSubtotal: true, color: 'teal' },
  { label: 'Operating Expenses', start: rev * 0.6, end: net, value: net - rev * 0.6, isSubtotal: false, color: 'red' },
  { label: 'Net Profit', start: 0, end: net, value: net, isSubtotal: true, color: net >= 0 ? 'teal' : 'red' },
];

/** The option exactly as `PackSectionView` builds it. */
function screen(steps: WaterfallStep[]): string {
  echarts.registerTheme('ff-legacy-test', buildTheme((name: string) => (name === '--ff-fig-font' ? MONO : '')));
  const chart = echarts.init(null, 'ff-legacy-test', { renderer: 'svg', ssr: true, width: WIDTH, height: HEIGHT });
  try {
    chart.setOption(legacyWaterfallOption(steps));
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

describe('the legacy screen bridge, in the screen\'s own face', () => {
  for (const [rev, net] of [[2_500_000, 300_000], [12_000_000, -3_000_000], [25_000_000, 2_000_000], [140_000_000, -30_000_000]]) {
    it(`keeps every axis label inside the chart at revenue ${rev}`, () => {
      const svg = screen(bridge(rev, net));
      const ticks = [...svg.matchAll(/text-anchor="end"[^>]*transform="translate\(([-\d.]+) ([-\d.]+)\)"[^>]*>([^<]*)<\/text>/g)];
      expect(ticks.length).toBeGreaterThan(2);
      for (const m of ticks) {
        const left = Number(m[1]) - m[3]!.length * MONO_EM * PX;
        expect(left, `tick "${m[3]}" starts at ${left.toFixed(1)}`).toBeGreaterThanOrEqual(0);
      }
      const names = [...svg.matchAll(/transform="matrix\(0.866,-0.5,0.5,0.866,([\d.]+),([\d.]+)\)"[^>]*>([^<]*)<\/text>/g)];
      expect(names.length).toBe(5);
      for (const m of names) {
        const width = m[3]!.length * MONO_EM * PX;
        const bottom = Number(m[2]) + 0.5 * width + 0.65 * PX * 0.866;
        expect(bottom, `"${m[3]}" reaches ${bottom.toFixed(1)}`).toBeLessThanOrEqual(HEIGHT);
      }
      const clip = clipRect(svg);
      for (const figure of figures(svg)) expect(outsideClip(figure, clip), `"${figure.text}" leaves the plot`).toBe(false);
    });
  }
});
