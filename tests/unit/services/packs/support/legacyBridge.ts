/**
 * The management pack's bridge as its print view draws it:
 * `legacyWaterfallOption` through the real renderer with the app's chart
 * theme registered — the theme `EChart` registers, whose own face is IBM Plex
 * Mono, which the option must override.
 */
import { echarts } from '@/lib/charts/echarts';
import { buildTheme } from '@/lib/charts/theme';
import { legacyWaterfallOption } from '@/components/accounting/packs/PackSectionView';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';

const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const THEME = 'ff-legacy-test';

/** Any option of that view's, under the theme `EChart` registers. */
export function renderLegacyOption(option: unknown, width: number, height: number): string {
  echarts.registerTheme(THEME, buildTheme((name: string) => (name === '--ff-fig-font' ? MONO : '')));
  const chart = echarts.init(null, THEME, { renderer: 'svg', ssr: true, width, height });
  try {
    chart.setOption(option as never);
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}

export function renderLegacyBridge(steps: WaterfallStep[], width: number, height: number): string {
  return renderLegacyOption(legacyWaterfallOption(steps, { heightPx: height, widthPx: width }), width, height);
}

/** Every font family the SVG sets a text in, as written. */
export function fontFamilies(svg: string): string[] {
  const texts = [...svg.matchAll(/<text\b([^>]*)>/g)].map((m) => /font-family:([^;"]*)/.exec(m[1]!)?.[1]?.trim() ?? '(none)');
  return [...new Set(texts)].sort();
}

/** The Demo company's management-pack bridge, as v67 and v70 rendered it. */
export const DEMO_MANAGEMENT_BRIDGE: WaterfallStep[] = [
  { label: 'Revenue', start: 0, end: 101_400, value: 101_400, isSubtotal: false, color: 'green' },
  { label: 'Cost of Sales', start: 101_400, end: -1_329_181, value: -1_430_581, labelValue: 1_430_581, isSubtotal: false, color: 'red' },
  { label: 'Gross Profit', start: 0, end: -1_329_181, value: -1_329_181, isSubtotal: true, color: 'teal' },
  { label: 'Operating Expenses', start: -1_329_181, end: -1_556_052, value: -226_871, labelValue: 226_871, isSubtotal: false, color: 'red' },
  { label: 'Other Income', start: -1_556_052, end: -1_544_240, value: 11_812, isSubtotal: false, color: 'green' },
  { label: 'Operating Profit', start: 0, end: -1_544_240, value: -1_544_240, isSubtotal: true, color: 'teal' },
  { label: 'Net Profit', start: 0, end: -1_544_240, value: -1_544_240, isSubtotal: true, color: 'red' },
];
