/**
 * ONE ZERO, ONE GLYPH — ACROSS UNITS, NOT JUST ACROSS COLUMNS.
 *
 * The demo pack's page-6 "Other expenses" row printed `–` under Actual,
 * Prior and Change and `0.0%` under % of Revenue. Page 12 defines the dash as
 * "that zero: a figure measured and nil", and defines nothing that
 * distinguishes it from the `0.0%` four centimetres to its right — four
 * measured zeros on one line rendered two ways. Brightsphere's equivalent
 * cell prints `n/m`, so the pack was not even doing it the same way on two
 * companies.
 *
 * THE TWO CASES ARE NOT THE SAME AND THE FIX MUST NOT COLLAPSE THEM.
 * Brightsphere's `n/m` is correct for a different reason: its revenue is
 * negative, so there is no base to take a share OF, and the cell carries a
 * null figure with `REVENUE_NOT_A_POSITIVE_BASE` as its stated reason. The
 * demo cell has a perfectly good base and a numerator of nil, which is a
 * measured zero and takes the pack's word for one. Nil numerator and
 * unusable denominator are two different facts; the pack states both and may
 * not state "nil" two ways on one row.
 */
import { describe, expect, it } from 'vitest';
import { formatFigureText } from '@/components/accounting/packs/primitives/packFigureText';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { REVENUE_NOT_A_POSITIVE_BASE } from '@/modules/accounting/services/packs/pages/packStatementTables';
import { brightsphereInput, demoInput } from './fixtures/boardPackInputs';
import { liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';
import type { PackTable, PackTableRow } from '@/modules/accounting/services/packs/pages/packPageModel';

const ZERO_GLYPH = '–';

/** Every row of every table in the composed document, with its table. */
function rows(input: BoardPackInput): Array<[PackTable, PackTableRow]> {
  const out: Array<[PackTable, PackTableRow]> = [];
  for (const page of buildBoardPackPages(input).pages) {
    for (const block of page.blocks) {
      if (block.kind !== 'table') continue;
      for (const row of block.table.rows) out.push([block.table, row]);
    }
  }
  return out;
}

describe('a nil share of a positive base', () => {
  it('prints the same glyph as the nil money on its own row', () => {
    // The row the gate found: "Other expenses" is nil on this fixture and
    // revenue is a healthy positive, so the share is a real zero.
    const found = rows(liveDemoRenderedInput).filter(([, row]) => {
      const pct = row.figures.pctOfRevenue;
      return pct !== undefined && pct.value !== null && Math.abs(pct.value) < 0.005;
    });
    expect(found.map(([, r]) => r.label), 'no nil share is printed at all, so nothing is tested')
      .not.toEqual([]);
    for (const [, row] of found) {
      expect(formatFigureText(row.figures.pctOfRevenue!, PACK_SCALE), row.label).toBe(ZERO_GLYPH);
      // And the money cell beside it, which was always the dash — the point
      // is that the two now agree, not that either changed alone.
      expect(formatFigureText(row.figures.actual!, PACK_SCALE), row.label).toBe(ZERO_GLYPH);
    }
  });

  it('leaves a share of a base that is not positive as a stated reason', () => {
    const bs = rows(brightsphereInput).filter(([, row]) => row.figures.pctOfRevenue !== undefined);
    expect(bs.length, 'the distressed fixture prints no % of revenue column').toBeGreaterThan(0);
    const unusable = bs.filter(([, row]) => row.figures.pctOfRevenue!.value === null);
    expect(unusable.length, 'no cell on the negative-revenue company is n/m').toBeGreaterThan(0);
    for (const [, row] of unusable) {
      expect(row.figures.pctOfRevenue!.unavailable).toBe(REVENUE_NOT_A_POSITIVE_BASE);
      expect(formatFigureText(row.figures.pctOfRevenue!, PACK_SCALE))
        .toBe(REVENUE_NOT_A_POSITIVE_BASE);
    }
  });

  it('is a rule about the unit, not about one column', () => {
    const p = new PackFigureProvenance();
    for (const format of ['pct', 'ratio', 'days'] as const) {
      expect(formatFigureText(p.figure(`t.${format}`, 0, format), PACK_SCALE), format)
        .toBe(ZERO_GLYPH);
    }
    // And a figure that is NOT nil still prints its own unit, so the rule
    // cannot be satisfied by returning the dash for everything.
    expect(formatFigureText(p.figure('t.live', 12.3, 'pct'), PACK_SCALE)).toBe('+12.3%');
  });

  it('holds on both companies of the composed pack', () => {
    for (const [name, input] of [['demo', demoInput], ['brightsphere', brightsphereInput]] as const) {
      for (const [, row] of rows(input)) {
        for (const figure of Object.values(row.figures)) {
          if (figure === undefined || figure.value === null) continue;
          if (Math.abs(figure.value) >= 0.005) continue;
          expect(formatFigureText(figure, PACK_SCALE), `${name}: ${row.label}`).toBe(ZERO_GLYPH);
        }
      }
    }
  });
});
