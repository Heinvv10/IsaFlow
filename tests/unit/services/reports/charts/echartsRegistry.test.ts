/**
 * `echarts.ts` registers `TitleComponent` so `buildSmallMultiplesOption`'s
 * panel titles actually render. Nothing else in the suite renders an option
 * through echarts itself — the builder tests only assert on the plain option
 * object — so a dropped registration would go unnoticed until a screen
 * showed panels with no labels. This renders the real registry module
 * through node SSR and asserts the title text lands in the SVG.
 */
import { describe, it, expect } from 'vitest';
import { echarts } from '@/lib/charts/echarts';
import {
  buildSmallMultiplesOption, type TrendPanel,
} from '@/components/accounting/charts/smallMultiplesOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';

const MONTHS = ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
const PANELS: TrendPanel[] = [
  { key: '1000', label: 'Sales', values: Array(12).fill(1000) },
];

describe('echarts registry', () => {
  it('renders a panel title through node SSR', () => {
    const option = buildSmallMultiplesOption(PANELS, MONTHS, DEFAULT_PALETTE, { columns: 1 });
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 400, height: 300 });
    chart.setOption(option);
    const svg = chart.renderToSVGString();
    chart.dispose();

    expect(svg).toContain('Sales');
  });
});
