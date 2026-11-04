import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { demoInput, demoSet } from '../services/packs/fixtures/boardPackInputs';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/packBoardPackInput';

/** Demo figures at demo scale, cost of sales a net credit, unexplained interest/tax step of 3% of operating profit. */
function input(): BoardPackInput {
  const c = demoSet.current;
  const costOfSales = -c.costOfSales;
  const op = c.revenue - costOfSales + (c.otherIncome ?? 0) - c.operatingExpenses;
  const netProfit = op - (c.otherExpenses ?? 0) - Math.round(Math.abs(op) * 0.03);
  return { ...demoInput, set: { ...demoSet, current: { ...c, costOfSales, operatingProfit: op, netProfit } } };
}

describe('REPRO 2: the new note pushes the fitter to drop anchored footnotes; the omission note takes a live anchor number', () => {
  it('every superscript in the page 6 table points at a footnote that is about that row/column', () => {
    const p6 = buildBoardPackPages(input()).pages.find((p) => p.navLabel === 'Income statement')!;
    const t = p6.blocks.flatMap((b) => (b.kind === 'table' && b.table.rows.some((r) => r.key === 'is.revenue') ? [b.table] : []))[0]!;
    const byNumber = new Map(p6.footnotes.map((f) => [f.number, f.text]));
    const anchors = [
      ...t.rows.filter((r) => r.footnote !== undefined).map((r) => ({ at: `row ${r.label}`, n: r.footnote! })),
      ...(t.columnNotes ?? []).map((cn) => ({ at: `column ${cn.column}`, n: cn.footnote })),
    ];
    const bad = anchors.filter((a) => !byNumber.has(a.n) || byNumber.get(a.n)!.startsWith('Not printed on this page'))
      .map((a) => `${a.at} -> ${a.n}: ${byNumber.get(a.n)?.slice(0, 40) ?? '(no such footnote on the page)'}`);
    expect(bad).toEqual([]);
  });
});
