/**
 * Runs under vitest.components.config.ts.
 *
 * A TILE WHOSE MOVEMENT ROUNDS TO NIL READS FLAT. A change of 0.04% printed
 * "↑ up 0.0% prior period" — an arrow and a word for a direction the digits
 * do not carry. It reads "→ flat on prior period", and the height model
 * charges the line the tile prints.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { KpiTileWithSparkline } from '@/components/accounting/packs/primitives/KpiTileWithSparkline';
import type { PackKpiTile } from '@/modules/accounting/services/packs/pages/packPageModel';

const tile = (value: number, unit: 'percent' | 'points'): PackKpiTile => ({
  label: 'Revenue',
  figure: { value: 1_000_000, format: 'money', source: 't.v' },
  delta: { value, unit, basis: 'prior period', favourable: value > 0 },
  deltaAbsence: null,
  trendFootnote: null,
  sparklineSvg: null,
} as unknown as PackKpiTile);

const line = (t: PackKpiTile) => renderToStaticMarkup(<KpiTileWithSparkline tile={t} scale="R" />)
  .match(/<span class="pack-kpi-delta[^"]*">(.*?)<\/span>\s*<\/div>|<span class="pack-kpi-delta[^"]*">(.*)$/s)![0]!
  .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

describe('a tile movement that rounds to nil', () => {
  it.each([[0.04, 'percent'], [-0.02, 'points'], [0, 'percent']] as const)('%s %s reads flat', (value, unit) => {
    expect(line(tile(value, unit))).toBe('→ flat on prior period');
  });

  it('a real movement keeps its arrow and figure', () => {
    expect(line(tile(1.25, 'percent'))).toBe('↑ up 1.3% prior period');
    expect(line(tile(-0.06, 'points'))).toBe('↓ down 0.1 pp prior period');
  });
});
