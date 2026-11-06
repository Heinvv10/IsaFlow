/**
 * The fit model measures the words the tile prints, so it must pick the same direction word the tile does: a movement
 * that rounds to nothing prints "flat", not "up" or "down" by its sign (blind review LOW).
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { KpiTileWithSparkline } from '@/components/accounting/packs/primitives/KpiTileWithSparkline';
import { deltaText } from '@/modules/accounting/services/packs/pages/packFigureFit';
import type { PackKpiTile } from '@/modules/accounting/services/packs/pages/packPageModel';

const tile = (value: number, unit: 'percent' | 'points'): PackKpiTile => ({
  label: 'Revenue', figure: { source: 'is.revenue', value: 1000, format: 'money' },
  delta: { value, unit, basis: 'prior period', favourable: true }, trendFootnote: null, sparklineSvg: null,
} as unknown as PackKpiTile);

describe('deltaText is the line the tile prints', () => {
  it.each([[12.3, 'percent'], [-12.3, 'percent'], [0.0004, 'percent'], [-0.0004, 'percent'], [3.2, 'points'], [-0.01, 'points'], [0, 'percent']] as const)(
    '%s %s', (value, unit) => {
      const t = tile(value, unit);
      const { container } = render(<KpiTileWithSparkline tile={t} scale="R'000" />);
      const printed = (container.querySelector('.pack-kpi-delta')?.textContent ?? '').replace(/^\S+\s/, '').replace(/\s+/g, ' ').trim();
      expect(printed).toBe(deltaText(t));
    },
  );

  it('a movement that rounds to nothing is "flat", whichever its sign', () => {
    expect(deltaText(tile(0.0004, 'percent'))).toMatch(/^flat/);
    expect(deltaText(tile(-0.0004, 'percent'))).toMatch(/^flat/);
  });
});
