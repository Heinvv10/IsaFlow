import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { assertPackIntegrity } from '@/modules/accounting/services/packs/figures/packFigureIntegrity';
import { demoInput, demoSet } from '../services/packs/fixtures/boardPackInputs';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/packBoardPackInput';

/** Demo figures at demo scale, with cost of sales a net credit and an unexplained interest/tax step of 20% of operating profit. */
function creditCostOfSalesWithTax(withBudget: boolean): BoardPackInput {
  const c = demoSet.current;
  const costOfSales = -c.costOfSales;
  const op = c.revenue - costOfSales + (c.otherIncome ?? 0) - c.operatingExpenses;
  const netProfit = op - (c.otherExpenses ?? 0) - Math.round(Math.abs(op) * 0.2);
  return { ...demoInput, set: { ...demoSet, current: { ...c, costOfSales, operatingProfit: op, netProfit }, budget: withBudget ? demoSet.budget : null } };
}

describe('REPRO 1: the required dropped-columns footnote refuses a pack the old code printed', () => {
  it('the same company without a budget gets its pack (control)', () => {
    expect(() => buildBoardPackPages(creditCostOfSalesWithTax(false))).not.toThrow();
  });
  it('with a budget, page 6 drops the columns and the pack is still produced', () => {
    const doc = buildBoardPackPages(creditCostOfSalesWithTax(true));
    expect(() => assertPackIntegrity(doc)).not.toThrow();
    const p6 = doc.pages.find((p) => p.navLabel === 'Income statement')!;
    expect(p6.blocks.some((b) => b.kind === 'table' && b.table.columns.includes('budget'))).toBe(false);
  });
});
