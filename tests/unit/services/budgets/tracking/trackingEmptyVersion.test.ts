/**
 * Review round 3, R9: a version with no budget rows at all (what resolvePrimaryVersion({ create:
 * true }) leaves) is no budget: its year is a no-version year for the gap rule, FY* included.
 */
import { describe, expect, it } from 'vitest';
import { noVersionYearsOf } from '@/modules/accounting/services/budgets/tracking/trackingBudgetRead';

const scope = [
  { fiscalYear: 2026, versionId: 'empty', first: '2026-01-01', last: '2026-02-01' },
  { fiscalYear: 2027, versionId: 'full', first: '2026-03-01', last: '2027-04-01' },
  { fiscalYear: 2028, versionId: null, first: '2027-05-01', last: '2028-04-01' },
];

describe('noVersionYearsOf', () => {
  it('lists a year with no version AND a year whose version holds no rows', () => {
    expect(noVersionYearsOf(scope, new Set(['full']))).toEqual([2026, 2028]);
  });
  it('a version with rows is a budget, whatever their amounts', () => {
    expect(noVersionYearsOf(scope, new Set(['full', 'empty']))).toEqual([2028]);
  });
});
