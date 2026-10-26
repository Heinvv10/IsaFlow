import { describe, it, expect } from 'vitest';
import { buildBudgetVsActualLines, type RawActualRow } from '@/modules/accounting/services/reports/budgetVsActualLines';
import { buildBudgetVsActualSections } from '@/modules/accounting/services/reports/budgetVsActualSections';

const row = (code: string, type: 'revenue' | 'expense', actual: number): RawActualRow => ({
  id: `id-${code}`, account_code: code, account_name: `Acc ${code}`, account_type: type, actual_amount: actual,
});

describe('buildBudgetVsActualSections', () => {
  it('net profit = revenue − expenses, budget and actual', () => {
    const lines = buildBudgetVsActualLines(
      [row('4000', 'revenue', 1200), row('4100', 'revenue', 300), row('6000', 'expense', 800), row('6100', 'expense', 100)],
      { '4000': 1000, '4100': 500, '6000': 600, '6100': 200 },
    );
    const s = buildBudgetVsActualSections(lines);
    expect(s.revenue).toMatchObject({ budget: 1500, actual: 1500, variance: 0, movement: 0, favourable: true });
    expect(s.expense).toMatchObject({ budget: 800, actual: 900, variance: -100, movement: 100, favourable: false });
    expect(s.expense.movement_pct).toBeCloseTo(12.5);
    expect(s.expense.variance_pct).toBeCloseTo(-12.5);
    expect(s.net_profit).toMatchObject({ budget: 700, actual: 600, variance: -100, movement: -100, favourable: false });
    expect(s.net_profit.movement_pct).toBeCloseTo(-100 / 7);
    expect(s.net_profit.key).toBe('net_profit');
  });

  it('NP variance equals Σ line variance (property, 200 random line sets)', () => {
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const cents = () => Math.round((rand() * 200000 - 50000)) / 100;
    for (let i = 0; i < 200; i++) {
      const n = 1 + Math.floor(rand() * 12);
      const raws: RawActualRow[] = [];
      const budgets: Record<string, number> = {};
      for (let j = 0; j < n; j++) {
        const code = String(4000 + j);
        raws.push(row(code, rand() < 0.5 ? 'revenue' : 'expense', cents()));
        if (rand() < 0.7) budgets[code] = cents();
      }
      const lines = buildBudgetVsActualLines(raws, budgets);
      const s = buildBudgetVsActualSections(lines);
      const sum = Math.round(lines.reduce((t, l) => t + l.variance, 0) * 100) / 100;
      expect(s.net_profit.variance).toBe(sum);
      expect(s.net_profit.movement).toBe(s.net_profit.variance);
      expect(s.net_profit.actual).toBe(Math.round((s.revenue.actual - s.expense.actual) * 100) / 100);
    }
  });

  it('section with nothing budgeted: pct and favourable null', () => {
    const lines = buildBudgetVsActualLines([row('4000', 'revenue', 50), row('6000', 'expense', 80)], { '6000': 100 });
    const s = buildBudgetVsActualSections(lines);
    expect(s.revenue.variance_pct).toBeNull();
    expect(s.revenue.movement_pct).toBeNull();
    expect(s.revenue.favourable).toBeNull();
    expect(s.revenue.actual).toBe(50);
    expect(s.expense.favourable).toBe(true);
    // NP budget 0 − 100 = −100, actual 50 − 80 = −30: R70 better than plan.
    expect(s.net_profit).toMatchObject({ budget: -100, actual: -30, variance: 70, favourable: true });
    expect(s.net_profit.movement_pct).toBeCloseTo(70);
  });

  it('empty input: three zero sections, nothing budgeted', () => {
    const s = buildBudgetVsActualSections([]);
    for (const k of ['revenue', 'expense', 'net_profit'] as const) {
      expect(s[k]).toMatchObject({ budget: 0, actual: 0, variance: 0, movement: 0, variance_pct: null, movement_pct: null, favourable: null });
    }
  });
});
