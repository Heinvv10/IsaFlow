/**
 * The management pack's bridge as the screen draws it: `legacyWaterfallOption`
 * through the real renderer with the view's theme registered, chart text in
 * IBM Plex Mono.
 */
import { echarts } from '@/lib/charts/echarts';
import { buildTheme } from '@/lib/charts/theme';
import { legacyWaterfallOption } from '@/components/accounting/packs/PackSectionView';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';

const MONO = "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const THEME = 'ff-legacy-test';

export function renderLegacyBridge(steps: WaterfallStep[], width: number, height: number): string {
  echarts.registerTheme(THEME, buildTheme((name: string) => (name === '--ff-fig-font' ? MONO : '')));
  const chart = echarts.init(null, THEME, { renderer: 'svg', ssr: true, width, height });
  try {
    chart.setOption(legacyWaterfallOption(steps, height));
    return chart.renderToSVGString();
  } finally {
    chart.dispose();
  }
}
