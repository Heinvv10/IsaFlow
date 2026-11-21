/** Breaker r7: a header tie's residual never goes negative, a negative subtotal included (budgets/billAttribution). */
import { describe, expect, it } from 'vitest';
import { headerResidualCents } from '@/modules/accounting/services/budgets/billAttribution';

describe('headerResidualCents', () => {
  it('is the subtotal less what the bill holds elsewhere, kept between 0 and the subtotal', () => {
    expect([headerResidualCents(1000, 300), headerResidualCents(1000, 1300), headerResidualCents(1000, -50)]).toEqual([700, 0, 1000]);
  });
  it('a negative subtotal (a credit-like bill) holds 0, never less', () => {
    expect([headerResidualCents(-500, 0), headerResidualCents(-500, -800)]).toEqual([0, 0]);
  });
});
