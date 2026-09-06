import { describe, it, expect } from 'vitest';
import { DENSITY_COLUMNS } from '@/components/accounting/reportControls/useComparatorColumns';

describe('DENSITY_COLUMNS', () => {
  it('opens the owner view with a clean statement', () => {
    expect(DENSITY_COLUMNS.owner).toEqual({ prior: false, budget: false, variance: false, trend: false });
  });

  it('opens the accountant view on prior and variance, and never on a variance with nothing behind it', () => {
    expect(DENSITY_COLUMNS.accountant.prior).toBe(true);
    expect(DENSITY_COLUMNS.accountant.variance).toBe(true);
    expect(DENSITY_COLUMNS.accountant.variance && !DENSITY_COLUMNS.accountant.prior
      && !DENSITY_COLUMNS.accountant.budget).toBe(false);
  });
});
