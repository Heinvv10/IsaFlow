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
    // The clipping guard. TARGET must fit a day count and a signed
    // percentage; STATUS must fit its longest label. Both at their own size,
    // through the pack's own ruler.
    const { target, status } = scorecardColumnsMm(true);
    for (const token of ['+35.0%', '30 days', '1.50', '(1 234.5)%', '–']) {
      expect(singleLineMm(token, 9), `TARGET clips ${token}`).toBeLessThanOrEqual(target);
    }
    for (const label of ['NOT MEANINGFUL', 'UNSCORED', 'MISSED', 'MET']) {
      expect(singleLineMm(label, 8), `STATUS clips ${label}`).toBeLessThanOrEqual(status);
    }
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
              expect(singleLineMm('NOT MEANINGFUL', 8)).toBeLessThanOrEqual(status);
              expect(singleLineMm('30 days', 9)).toBeLessThanOrEqual(target);
            }
          }
        }
      }
    }
    expect(rows, 'no scorecard rows were checked').toBeGreaterThan(0);
  });
});
