/**
 * THE TILE IS CHARGED FOR THE DELTA LINE IT PRINTS.
 *
 * `kpiTileHeight` charged every percentage delta as the fixed string
 * "up 00.0%". The tile prints its own direction word, and "down" is two
 * characters wider than "up" on a line set across a quarter of the measure
 * with no slack: a falling figure wrapped to a second line the model had not
 * paid for. A height model that reads short is how a page takes a second
 * sheet, so the charge is the text — never less than what that text needs.
 */
import { describe, expect, it } from 'vitest';
import { kpiTileHeight } from '@/modules/accounting/services/packs/pages/packBlockHeights';
import { deltaWithWord } from '@/modules/accounting/services/packs/narrative/derivedCaptions';
import { lines, wrappedLines } from '@/modules/accounting/services/packs/pages/packTextMetrics';
import type { PackKpiDelta, PackKpiTile } from '@/modules/accounting/services/packs/pages/packPageModel';

/** The measure the model wraps the delta line at — `KPI_DELTA_MEASURE_MM`. */
const COLUMN_MM = 38;

const tile = (delta: PackKpiDelta | null): PackKpiTile => ({
  label: 'Revenue',
  figure: { value: 1_000_000, format: 'money', source: 'packFigureSet.current.revenue' },
  delta,
  deltaAbsence: delta === null ? 'noComparativePeriod' : null,
  trendFootnote: null,
  sparklineSvg: null,
  sparklineWindow: null,
  sparklineScale: null,
});

const delta = (value: number, unit: PackKpiDelta['unit']): PackKpiDelta =>
  ({ value, unit, basis: 'prior period', favourable: value > 0 });

/** The millimetres the delta line costs a tile, read off the model. */
const deltaMm = (d: PackKpiDelta): number => kpiTileHeight(tile(d)) - kpiTileHeight(tile(null));

/** What the text the tile prints needs: the glyph, the words, the basis. */
function neededMm(d: PackKpiDelta): number {
  const word = d.value > 0 ? 'up' : d.value < 0 ? 'down' : 'flat';
  const printed = `X ${deltaWithWord(d, word, word, 'pp')} ${d.basis}`;
  return 1 + lines(wrappedLines(printed, 9, COLUMN_MM), 12);
}

describe('kpiTileHeight charges the delta line the tile prints', () => {
  const CASES: Array<[string, PackKpiDelta]> = [
    ['up 12.0%', delta(12, 'percent')],
    ['down 12.0%', delta(-12, 'percent')],
    ['down 2.0%', delta(-2, 'percent')],
    ['flat 0.0%', delta(0, 'percent')],
    ['up 100.0%', delta(100, 'percent')],
    ['up 3.0 pp', delta(3, 'points')],
    ['down 3.0 pp', delta(-3, 'points')],
    ['down 12.0 pp', delta(-12, 'points')],
  ];

  it.each(CASES)('%s is charged at least what its text needs', (_text, d) => {
    // A millionth of a millimetre of float slack: `deltaMm` is a difference.
    expect(deltaMm(d)).toBeGreaterThanOrEqual(neededMm(d) - 1e-6);
  });

  it('is the case under test — a down delta needs a line an up delta does not', () => {
    expect(neededMm(delta(-12, 'percent'))).toBeGreaterThan(neededMm(delta(12, 'percent')));
  });
});

/**
 * WHAT CHROMIUM DID WITH TWELVE DELTA LINES, on the demo company's page 3
 * through the print harness (`printBoardPack`, read back with `pdftotext`).
 * The model has to charge two lines wherever the paper took two — that is the
 * defect — and should not charge two where the paper took one: page 3 has no
 * line to give away, and an over-charge is paid for out of a disclosure.
 */
describe('the delta line wraps in the model where it wrapped on the paper', () => {
  const ONE_LINE = 1 + lines(1, 12);
  const TWO_LINES = 1 + lines(2, 12);
  const OBSERVED: Array<[string, PackKpiDelta, number]> = [
    ['up 12.0%', delta(12, 'percent'), ONE_LINE],
    ['up 33.9%', delta(33.9, 'percent'), ONE_LINE],
    ['up 100.0%', delta(100, 'percent'), ONE_LINE],
    ['flat 0.0%', delta(0, 'percent'), ONE_LINE],
    ['down 2.6%', delta(-2.6, 'percent'), ONE_LINE],
    ['down 9.9%', delta(-9.9, 'percent'), ONE_LINE],
    ['up 1.0 pp', delta(1, 'points'), ONE_LINE],
    ['up 12.0 pp', delta(12, 'points'), ONE_LINE],
    ['down 12.0%', delta(-12, 'percent'), TWO_LINES],
    ['down 100.0%', delta(-100, 'percent'), TWO_LINES],
    ['down 3.0 pp', delta(-3, 'points'), TWO_LINES],
    ['down 12.0 pp', delta(-12, 'points'), TWO_LINES],
  ];

  it.each(OBSERVED)('%s', (_text, d, observed) => {
    expect(deltaMm(d)).toBeCloseTo(observed, 6);
  });
});
