/**
 * A DECLARED COMPARATIVE COLUMN WITH NO FIGURE IN IT IS NOT A NIL.
 *
 * `ComparativeTable` prints `–` where a column the table declares carries no
 * figure on a row, and page 12 defines `–` as a figure measured and nil. Page
 * 8's opening cash therefore printed a measured nil prior, a measured nil
 * change and a measured nil percentage against an actual of (125) — three
 * cells asserting no movement on the one row of the pack whose comparative is
 * a period the figure set does not carry.
 *
 * This file holds the MODEL half — the three cells are declared, with a
 * stated reason. `tests/unit/components/packs/absentPriorCell.test.tsx` holds
 * the renderer half. Reverting `buildRow`'s absent-prior branch makes these
 * fail; reverting the reason makes `PackFigureProvenance.figure` throw.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { demoInput } from './fixtures/boardPackInputs';
import { liveDemoInput } from './fixtures/liveDemoBoardPack';
import type { PackPagesDocument, PackTable } from '@/modules/accounting/services/packs/pages/packPageModel';

function cashTable(doc: PackPagesDocument): PackTable {
  for (const page of doc.pages) {
    for (const block of page.blocks) {
      if (block.kind !== 'table') continue;
      if (block.table.rows.some((row) => row.label === 'Opening cash')) return block.table;
    }
  }
  throw new Error('no cash table in this pack');
}

describe('a comparative cell with no figure states why', () => {
  for (const [name, input] of [['demo', demoInput], ['live demo', liveDemoInput]] as const) {
    it(`declares opening cash's prior, change and change % on the ${name} pack`, () => {
      const table = cashTable(buildBoardPackPages(input));
      // The row only has this problem on a table that PRINTS a comparative.
      expect(table.columns).toContain('prior');
      const opening = table.rows.find((row) => row.label === 'Opening cash')!;
      // The actual is a real figure — this is not the "nothing was captured"
      // path the renderer already rescues.
      expect(opening.figures.actual?.value).not.toBeNull();
      for (const column of ['prior', 'change', 'changePct'] as const) {
        const figure = opening.figures[column];
        expect(figure, column).toBeDefined();
        expect(figure!.value, column).toBeNull();
        expect(figure!.unavailable ?? '', column).toMatch(/comparative period/);
      }
    });
  }

});
