import { describe, expect, it, vi } from 'vitest';
import { log } from '@/lib/logger';
import { BUDGET_COLUMNS_DROPPED_NOTE } from '@/modules/accounting/services/packs/pages/packIncomeBudget';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import { demoInput, demoSet } from '../services/packs/fixtures/boardPackInputs';
import { page6Input } from '../services/packs/fixtures/page6Shapes';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/packBoardPackInput';

/** Demo figures at demo scale, with cost of sales a net credit and an unexplained interest/tax step of 20% of operating profit. */
function creditCostOfSalesWithTax(withBudget: boolean): BoardPackInput {
  const c = demoSet.current;
  const costOfSales = -c.costOfSales;
  const op = c.revenue - costOfSales + (c.otherIncome ?? 0) - c.operatingExpenses;
  const netProfit = op - (c.otherExpenses ?? 0) - Math.round(Math.abs(op) * 0.2);
  return { ...demoInput, set: { ...demoSet, current: { ...c, costOfSales, operatingProfit: op, netProfit }, budget: withBudget ? demoSet.budget : null } };
}

describe('regression: the dropped-columns footnote must not refuse a pack the old layout printed', () => {
  it('the same company without a budget gets its pack (control)', () => {
    expect(() => buildBoardPackPages(creditCostOfSalesWithTax(false))).not.toThrow();
  });
  it('with a budget, page 6 drops the columns and the pack is still produced', () => {
    const doc = buildBoardPackPages(creditCostOfSalesWithTax(true));
    expect(() => assertPackIntegrity(doc)).not.toThrow();
    const p6 = doc.pages.find((p) => p.navLabel === 'Income statement')!;
    // The derived caption goes first now, so at demo scale the page keeps its Budget and Variance columns
    // (before, it had already thrown away their footnote and left the columns out). With prose set at its own
    // widths it keeps the caption too: nothing on the page is given up.
    expect(p6.blocks.some((b) => b.kind === 'table' && b.table.columns.includes('budget'))).toBe(true);
    expect(p6.blocks.some((b) => b.kind === 'narrative')).toBe(true);
  });
});

/** Net-debit revenue, every line below zero and a 20% interest/tax step at demo scale: dropping the caption does not make room for the columns, so page 6 falls back to the old layout. (Three lines and a 5% step make room once prose is set at its own widths.) */
const CROWDED = { k: 1, negative: true, loss: false, plug: 0.2, sg: [-1, -1, -1, -1] };

describe('a crowded page 6 falls back to the old layout rather than refuse the pack', () => {
  it('drops the columns, prints no dropped-columns note, still builds, and logs the warning', () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    try {
      const doc = buildBoardPackPages(page6Input(CROWDED));
      const p6 = doc.pages.find((p) => p.navLabel === 'Income statement')!;
      expect(p6.blocks.some((b) => b.kind === 'table' && b.table.columns.includes('budget'))).toBe(false);
      expect(p6.footnotes.some((f) => f.text === BUDGET_COLUMNS_DROPPED_NOTE)).toBe(false);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('cannot fit the Budget and Variance columns'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

/** Demo figures at demo scale, cost of sales a net credit, unexplained interest/tax step of 3% of operating profit. */
function creditCostOfSalesSmallTaxStep(): BoardPackInput {
  const c = demoSet.current;
  const costOfSales = -c.costOfSales;
  const op = c.revenue - costOfSales + (c.otherIncome ?? 0) - c.operatingExpenses;
  const netProfit = op - (c.otherExpenses ?? 0) - Math.round(Math.abs(op) * 0.03);
  return { ...demoInput, set: { ...demoSet, current: { ...c, costOfSales, operatingProfit: op, netProfit } } };
}

describe('regression: the dropped-columns note must not make the fitter drop anchored footnotes (superscripts stay on the right note)', () => {
  it('every superscript in the page 6 table points at a footnote that is about that row/column', () => {
    const p6 = buildBoardPackPages(creditCostOfSalesSmallTaxStep()).pages.find((p) => p.navLabel === 'Income statement')!;
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
