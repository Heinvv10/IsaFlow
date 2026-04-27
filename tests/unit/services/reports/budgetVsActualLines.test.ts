import { describe, it, expect } from 'vitest';
import {
  buildBudgetVsActualLines,
  type RawActualRow,
} from '@/modules/accounting/services/reports/budgetVsActualLines';

const REVENUE_ACCOUNT_ID  = 'rev-acc-001';
const EXPENSE_ACCOUNT_ID  = 'exp-acc-001';
const HEADER_ACCOUNT_ID   = 'hdr-acc-001';
const NEW_ACCOUNT_ID      = 'new-acc-001';

const REVENUE_ROW: RawActualRow = {
  id: REVENUE_ACCOUNT_ID,
  account_code: '4000',
  account_name: 'Sales',
  account_type: 'revenue',
  actual_amount: 1200,
};

const EXPENSE_ROW: RawActualRow = {
  id: EXPENSE_ACCOUNT_ID,
  account_code: '6000',
  account_name: 'Cost of Sales',
  account_type: 'expense',
  actual_amount: 800,
};

const HEADER_ROW: RawActualRow = {
  id: HEADER_ACCOUNT_ID,
  account_code: '5000',
  account_name: 'Operating Expenses (header)',
  account_type: 'expense',
  actual_amount: 0,
};

const NEW_ROW_NO_ACTUALS: RawActualRow = {
  id: NEW_ACCOUNT_ID,
  account_code: '7000',
  account_name: 'New Expense Account',
  account_type: 'expense',
  actual_amount: 0,
};

describe('buildBudgetVsActualLines', () => {
  describe('variance signs', () => {
    it('revenue: actual > budget = positive variance (good)', () => {
      const lines = buildBudgetVsActualLines([REVENUE_ROW], { '4000': 1000 });
      expect(lines).toHaveLength(1);
      expect(lines[0]?.variance).toBe(200);
      // variance_pct = 200 / 1000 * 100 = 20
      expect(lines[0]?.variance_pct).toBeCloseTo(20);
    });

    it('expense: actual < budget = positive variance (good — under budget)', () => {
      const lines = buildBudgetVsActualLines([EXPENSE_ROW], { '6000': 1000 });
      expect(lines).toHaveLength(1);
      expect(lines[0]?.variance).toBe(200);
      expect(lines[0]?.variance_pct).toBeCloseTo(20);
    });

    it('expense: actual > budget = negative variance (over budget)', () => {
      const lines = buildBudgetVsActualLines([EXPENSE_ROW], { '6000': 500 });
      expect(lines).toHaveLength(1);
      expect(lines[0]?.variance).toBe(-300);
      expect(lines[0]?.variance_pct).toBeCloseTo(-60);
    });
  });

  describe('budget lookup', () => {
    it('looks up by account_code first', () => {
      const lines = buildBudgetVsActualLines([EXPENSE_ROW], {
        '6000': 999,
        [EXPENSE_ACCOUNT_ID]: 1, // should NOT be used because code matches first
      });
      expect(lines[0]?.budget_amount).toBe(999);
    });

    it('falls back to account id when code is not in the map', () => {
      const lines = buildBudgetVsActualLines([EXPENSE_ROW], {
        [EXPENSE_ACCOUNT_ID]: 750,
      });
      expect(lines[0]?.budget_amount).toBe(750);
    });

    it('treats missing budget as zero', () => {
      const lines = buildBudgetVsActualLines([REVENUE_ROW], {});
      expect(lines[0]?.budget_amount).toBe(0);
    });

    it('preserves a legitimate zero budget on account_code (not falls through to id)', () => {
      const lines = buildBudgetVsActualLines([REVENUE_ROW], {
        '4000': 0,                         // explicit zero on the code
        [REVENUE_ACCOUNT_ID]: 99999,       // would be wrong if `||` were used
      });
      // The row has actual_amount > 0 so it survives the empty-state filter.
      expect(lines).toHaveLength(1);
      expect(lines[0]?.budget_amount).toBe(0);
    });
  });

  describe('variance_pct edge cases', () => {
    it('returns -100 when budget is 0 but actual is positive', () => {
      const lines = buildBudgetVsActualLines([REVENUE_ROW], {});
      expect(lines[0]?.variance_pct).toBe(-100);
    });

    it('returns 0 when both budget and actual are 0 (and the row would be filtered out anyway)', () => {
      const lines = buildBudgetVsActualLines([
        { ...REVENUE_ROW, actual_amount: 0 },
      ], {});
      // Filter drops zero/zero rows entirely.
      expect(lines).toHaveLength(0);
    });
  });

  describe('empty-state filter (the boundary the comment promises)', () => {
    it('drops accounts with zero budget AND zero actual (header rows)', () => {
      const lines = buildBudgetVsActualLines([HEADER_ROW, REVENUE_ROW], {
        '4000': 1000,
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]?.account_code).toBe('4000');
    });

    it('KEEPS a brand-new account that has a budget but no actuals yet', () => {
      const lines = buildBudgetVsActualLines([NEW_ROW_NO_ACTUALS], {
        '7000': 5000,
      });
      expect(lines).toHaveLength(1);
      expect(lines[0]?.budget_amount).toBe(5000);
      expect(lines[0]?.actual_amount).toBe(0);
      // Expense, actual=0, budget=5000 → variance = 5000 (under budget)
      expect(lines[0]?.variance).toBe(5000);
      expect(lines[0]?.variance_pct).toBeCloseTo(100);
    });

    it('KEEPS an account with actuals but no budget (over-spent)', () => {
      const lines = buildBudgetVsActualLines([EXPENSE_ROW], {});
      expect(lines).toHaveLength(1);
      expect(lines[0]?.budget_amount).toBe(0);
      expect(lines[0]?.actual_amount).toBe(800);
    });
  });

  describe('numeric coercion', () => {
    it('coerces string actuals (Postgres numeric → string) to number', () => {
      const lines = buildBudgetVsActualLines([
        { ...REVENUE_ROW, actual_amount: '1234.56' },
      ], { '4000': 1000 });
      expect(lines[0]?.actual_amount).toBeCloseTo(1234.56);
      expect(lines[0]?.variance).toBeCloseTo(234.56);
    });
  });
});
