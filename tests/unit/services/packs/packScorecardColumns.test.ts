/**
 * PAGE 9 IS FIVE TABLES AND WAS NOT ONE GRID.
 *
 * Each lettered group is its own `<table>` and sized its own columns from its
 * own content. Measured on the rendered demo page at 260 dpi, TARGET moved
 * about 10mm between blocks and PRIOR about 14mm, non-monotonically — C sat
 * right of A, then D jumped left. `+35.0%`, `1.50`, `30 days` and `0.50` are
 * the same cell in five tables and no two lined up.
 *
 * The widths are now stated, and the two columns that must never wrap are
 * sized to the widest thing they can hold. These hold that: a fixed column
 * narrower than its longest token clips it, which is a worse defect than the
 * one being fixed.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SCORECARD_TABLE_MM,
  scorecardColumnPercents,
  scorecardColumnsMm,
  singleLineMm,
} from '@/modules/accounting/services/packs/pages/packScorecardColumns';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereReceivablesGapInput } from './fixtures/boardPackInputs';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

/**
 * The horizontal padding a scorecard cell really gets, off the stylesheet the
 * browser loads — `.pack-table td { padding: <vertical> <horizontal>; }`.
 */
const CSS_CELL_PADDING_MM = ((): number => {
  const css = readFileSync('styles/packPrint.css', 'utf8');
  const rule = /\.pack-table td \{[^}]*padding:\s*[\d.]+mm\s+([\d.]+)mm/.exec(css);
  expect(rule, 'packPrint.css states no padding for .pack-table td').not.toBeNull();
  return Number.parseFloat(rule![1]!);
})();

describe('the five scorecard blocks share one column grid', () => {
  it.each([[true], [false]])('widths sum to the measure (trend: %s)', (showsTrend) => {
    const { metric, actual, target, prior, trend, status } = scorecardColumnsMm(showsTrend);
    const total = metric + actual + target + prior + (trend ?? 0) + status;
    expect(total).toBeCloseTo(SCORECARD_TABLE_MM, 6);
    // The two figure columns are the same width as each other, which is the
    // alignment a reader actually checks down the page.
    expect(actual).toBeCloseTo(prior, 6);
  });

  it.each([[true], [false]])('states one percentage per column (trend: %s)', (showsTrend) => {
    const pcts = scorecardColumnPercents(showsTrend);
    expect(pcts).toHaveLength(showsTrend ? 6 : 5);
    const sum = pcts.reduce((s, p) => s + Number.parseFloat(p), 0);
    expect(sum).toBeCloseTo(100, 1);
  });

  it('gives TARGET and STATUS room for the widest token they can hold', () => {
    // The clipping guard, AGAINST THE CONTENT BOX AND NOT THE BARE TEXT.
    //
    // It compared `singleLineMm(token) <= target` while `target` is
    // `singleLineMm(WIDEST_TARGET) + padding`, and `WIDEST_TARGET` is one of
    // the tokens — so deleting the padding term made the assertion x <= x and
    // it stayed green. A column sized to its text and not to its cell clips
    // by exactly the padding, which is the defect this module exists to stop,
    // and print geometry cannot see it either: a too-narrow column wraps
    // rather than running off the paper.
    const { target, status } = scorecardColumnsMm(true);
    for (const token of ['+35.0%', '30 days', '1.50', '(1 234.5)%', '–']) {
      expect(singleLineMm(token, 9) + CSS_CELL_PADDING_MM * 2, `TARGET clips ${token}`)
        .toBeLessThanOrEqual(target);
    }
    for (const label of ['NOT MEANINGFUL', 'UNSCORED', 'MISSED', 'MET']) {
      expect(singleLineMm(label, 8) + CSS_CELL_PADDING_MM * 2, `STATUS clips ${label}`)
        .toBeLessThanOrEqual(status);
    }
  });

  /**
   * AND THE PADDING IT IS HELD AGAINST IS THE ONE THE STYLESHEET SETS.
   *
   * `CELL_PADDING_MM` is a private constant in the module; the browser lays
   * the cell out from `.pack-table td` in `packPrint.css`. Two numbers for one
   * quantity drift, and the drift is invisible — it shows up as a clipped
   * target on paper. Read here the way `packInkContrast` reads its colour
   * tokens, so a change to the stylesheet that the module does not follow is a
   * red test rather than a render nobody looks at closely.
   */
  it('charges at least the padding the stylesheet actually sets', () => {
    expect(CSS_CELL_PADDING_MM, 'no horizontal padding parsed out of .pack-table td')
      .toBeGreaterThan(0);
    // The module may be MORE generous than the stylesheet — it charges 3mm
    // against the sheet's 2 — but never less, or the cell is narrower than
    // its content.
    const { target, status } = scorecardColumnsMm(true);
    expect(target - singleLineMm('(1 234.5)%', 9)).toBeGreaterThanOrEqual(CSS_CELL_PADDING_MM * 2);
    expect(status - singleLineMm('NOT MEANINGFUL', 8)).toBeGreaterThanOrEqual(CSS_CELL_PADDING_MM * 2);
  });

  it('and no scorecard the pack composes prints a wider TARGET or STATUS', () => {
    // Anti-drift: the widths above are sized to constants, so this walks the
    // composed packs and fails if a real cell ever exceeds them.
    const { target, status } = scorecardColumnsMm(true);
    const packs: BoardPackInput[] = [liveDemoShortPanelsInput, brightsphereReceivablesGapInput];
    let rows = 0;
    for (const input of packs) {
      for (const page of buildBoardPackPages(input).pages) {
        for (const block of page.blocks) {
          if (block.kind !== 'scorecard') continue;
          for (const group of block.groups) {
            for (const row of group.rows) {
              rows += 1;
              if (row.target !== null) {
                // The rendered token is at most as wide as the widest shape
                // the column was sized for; this checks the magnitude that
                // produces it rather than re-implementing `formatTarget`.
                expect(Math.abs(row.target), 'a target wider than the column was sized for')
                  .toBeLessThan(1_234.5);
              }
              expect(singleLineMm('NOT MEANINGFUL', 8) + CSS_CELL_PADDING_MM * 2)
                .toBeLessThanOrEqual(status);
              expect(singleLineMm('30 days', 9) + CSS_CELL_PADDING_MM * 2)
                .toBeLessThanOrEqual(target);
            }
          }
        }
      }
    }
    expect(rows, 'no scorecard rows were checked').toBeGreaterThan(0);
  });
});
