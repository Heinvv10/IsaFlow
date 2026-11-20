/** A PO line's open (committed) amount: line_total less its billing, floored at 0 and never above line_total (breaker BRK-E). */
import { describe, expect, it } from 'vitest';
import { openPoLineCents } from '@/modules/accounting/services/budgets/remainingBudgetCore';

const b = (amount: number) => ({ glAccountId: null, cc1Id: null, cc2Id: null, buId: null, month: '2026-06', amount });

describe('openPoLineCents', () => {
  it('nets billing, floored at 0', () => {
    expect(openPoLineCents(500, [b(200)])).toBe(30000);
    expect(openPoLineCents(500, [b(700)])).toBe(0);
  });
  it('a negative billed line (a discount naming the PO line) never lifts the line above its total', () => {
    expect(openPoLineCents(500, [b(-200)])).toBe(50000);
    expect(openPoLineCents(500, [b(100), b(-300)])).toBe(50000);
  });
});
