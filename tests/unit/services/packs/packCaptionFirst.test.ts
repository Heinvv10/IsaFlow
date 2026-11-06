/**
 * THE CAPTION GOES BEFORE THE FOOTNOTES, SO A BUDGET COMPANY KEEPS ITS BUDGET COLUMNS.
 *
 * The adversarial review of #1148 (11,520 inputs): with the caption taken last, a page that reached
 * it had already thrown away the footnote that names the Budget columns, and with it the columns, plus
 * one to three other footnotes it could have kept. Taken first, 232 of those keep their columns. The
 * columns' superscript still resolves to their footnote after the caption and the fitter's drops.
 */
import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';
import { pageBoxMm, pageMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
import { BUDGET_COLUMN_NOTE_START } from '@/modules/accounting/services/packs/pages/packStatementFootnotes';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';
import { input, type Shape } from './fixtures/page6Grid';

const SHAPES: Array<[string, Shape]> = [
  ['net-debit revenue, no prior, R-demo scale', { tr: 'demo', budget: true, prior: false, negative: true, loss: false, k: 1, plug: 0.05, sg: [-1, 1, -1, 1] }],
  ['ordinary revenue at R1m, prior and budget', { tr: 'demo', budget: true, prior: true, negative: false, loss: false, k: 1000, plug: 0.2, sg: [-1, 1, -1, -1] }],
];

function p6(shape: Shape): PackPage {
  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  try {
    const doc = buildBoardPackPages(input(shape));
    assertPackIntegrity(doc);
    return doc.pages.find((p) => p.navLabel === 'Income statement')!;
  } finally {
    warn.mockRestore();
  }
}

describe.each(SHAPES)('%s', (unused, shape) => {
  it('keeps the Budget and Variance columns and their footnote, and loses the derived caption', () => {
    const page = p6(shape);
    expect(pageMm(page)).toBeLessThanOrEqual(pageBoxMm(page));
    const table = page.blocks.find((b) => b.kind === 'table');
    if (table?.kind !== 'table') throw new Error('no table');
    expect(table.table.columns).toEqual(expect.arrayContaining(['budget', 'variance']));
    expect(page.blocks.some((b) => b.kind === 'narrative')).toBe(false);
    const budgetNote = page.footnotes.find((f) => f.text.startsWith(BUDGET_COLUMN_NOTE_START));
    expect(budgetNote, 'the Budget columns lost their footnote').toBeDefined();
    // The heading's superscript resolves to it.
    expect(table.table.columnNotes?.find((c) => c.column === 'budget')?.footnote).toBe(budgetNote!.number);
    expect(page.footnotes.find((f) => f.text.startsWith(OMISSION_MARK))?.text).toContain('1 derived caption');
  });

  it('keeps the figures: every printed actual is the input\'s', () => {
    const page = p6(shape);
    const table = page.blocks.find((b) => b.kind === 'table');
    if (table?.kind !== 'table') throw new Error('no table');
    const c = input(shape).set.current;
    const actual = Object.fromEntries(table.table.rows.map((r) => [r.key, r.figures.actual?.value]));
    expect(actual['is.revenue']).toBe(c.revenue);
    expect(actual['is.netProfit']).toBe(c.netProfit);
  });
});

describe("the fitter's instruction does not leak into the document", () => {
  it('no block of the composed pack carries `droppable`, whether or not the caption was dropped', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      for (const shape of [SHAPES[0]![1], { ...SHAPES[0]![1], plug: 0, negative: false, sg: [1, 1, 1, 1] }]) {
        const doc = buildBoardPackPages(input(shape));
        expect(JSON.stringify(doc.pages)).not.toContain('droppable');
        // And the second shape keeps its caption, so the flag was there to be stripped.
        const kept = doc.pages.find((p) => p.navLabel === 'Income statement')!.blocks.some((b) => b.kind === 'narrative');
        expect(kept).toBe(shape === SHAPES[0]![1] ? false : true);
      }
    } finally {
      warn.mockRestore();
    }
  });
});
