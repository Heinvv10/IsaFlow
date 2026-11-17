/**
 * Browser proof (2026-11-17): the runway's y-axis printed a padded, non-round max right above the top tick
 * ("21 600" over "20 000"). Rendered through ECharts SSR, every y label must sit on one even step, so the top
 * label is a round tick, and the axis still spans the data (negative weeks included).
 */
import { describe, expect, it } from 'vitest';
import { echarts } from '@/lib/charts/echarts';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';
import { buildCash13RunwayOption } from '@/components/accounting/cashForecast13/cash13RunwayOption';
import type { ForecastWeek } from '@/modules/accounting/services/cashForecast13/types';

function weeks(closingRand: number[]): ForecastWeek[] {
  return closingRand.map((r, i) => ({
    index: i, start: `2026-12-${String(i + 1).padStart(2, '0')}`, end: '2026-12-31',
    openingCents: 0, inflowsCents: 0, outflowsCents: 0, netCents: 0, closingCents: r * 100,
  }));
}

/** The y-axis labels as numbers (the figures, brackets negative), top first. */
function yLabels(option: unknown): number[] {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 800, height: 260 });
  try {
    chart.setOption(option as Record<string, unknown>);
    const svg = chart.renderToSVGString();
    return [...svg.matchAll(/<text\b[^>]*>([^<]*)<\/text>/g)]
      .map((m) => (m[1] ?? '').replace(/[\s ]/g, ''))
      .filter((t) => /^\(?[\d]+\)?$|^–$/.test(t))
      .map((t) => (t === '–' ? 0 : t.startsWith('(') ? -Number(t.slice(1, -1)) : Number(t)));
  } finally {
    chart.dispose();
  }
}

describe('runway y-axis', () => {
  it.each([
    ['max 20 000', [5_000, 12_000, 20_000, 18_000]],
    ['max 15 000', [15_000, 9_000, 3_000, 7_500]],
    ['dips below zero', [10_000, -4_300, -12_750, 2_000]],
  ])('%s: every label on one even step, spanning the data', (_name, closing) => {
    const labels = [...new Set(yLabels(buildCash13RunwayOption(weeks(closing), DEFAULT_PALETTE)))].sort((a, b) => a - b);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    const step = (labels[1] as number) - (labels[0] as number);
    labels.forEach((v, i) => expect(v).toBe((labels[0] as number) + i * step));
    expect(labels.at(-1)).toBeGreaterThanOrEqual(Math.max(0, ...closing));
    expect(labels[0]).toBeLessThanOrEqual(Math.min(0, ...closing));
  });
});
