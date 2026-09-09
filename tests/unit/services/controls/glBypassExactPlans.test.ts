import { expect, it } from 'vitest';
import { buildExactClosingPlan, calculateExactDepreciation } from '@/modules/accounting/services/gl/glBypassExactPlans';

it('closes normal and contra P&L balances without negative journal amounts', () => {
  expect(buildExactClosingPlan([
    { id: 'revenue', balance: '-100.01' }, { id: 'expense', balance: '40' },
    { id: 'contra', balance: '2.01' },
  ], 'retained')).toEqual([
    { glAccountId: 'revenue', debit: '100.01', credit: '0' },
    { glAccountId: 'expense', debit: '0', credit: '40' },
    { glAccountId: 'contra', debit: '0', credit: '2.01' },
    { glAccountId: 'retained', debit: '0', credit: '58' },
  ]);
});
it('retains exact cents beyond IEEE-754 integer precision', () => {
  expect(buildExactClosingPlan([{ id: 'revenue', balance: '-9007199254740993.01' }], 'retained'))
    .toContainEqual({ glAccountId: 'retained', debit: '0', credit: '9007199254740993.01' });
});
const input = { cost: '1200', residualPct: '0', usefulLifeYears: '1', taxLifeYears: '1',
  openingAccDep: '0', taxOpeningAccDep: '0', deferredTaxRate: '0.27',
  purchaseDate: '2026-01-01', periodDate: '2026-02-28' };
it('calculates exact policy and tax amounts from decimal source facts', () => {
  expect(calculateExactDepreciation(input)).toMatchObject({ policyDep: '100', taxDep: '100', policyClosing: '100', taxClosing: '100', deferredTax: '0' });
  expect(calculateExactDepreciation({ ...input, cost: '120000000000000000.12' })).toMatchObject({ policyDep: '10000000000000000.01' });
});
it('prorates the acquisition month and starts tax in the following month', () => {
  expect(calculateExactDepreciation({ ...input, purchaseDate: '2026-02-15' })).toMatchObject({ policyDep: '50', taxDep: '0' });
});
it('caps at remaining depreciation and refuses malformed or impossible input', () => {
  expect(calculateExactDepreciation({ ...input, openingAccDep: '1199.99' })).toMatchObject({ policyDep: '0.01' });
  for (const override of [{ cost: 'NaN' }, { usefulLifeYears: '0' }, { residualPct: '1.01' }, { periodDate: '2026-02-30' }, { openingAccDep: '1200.01' }]) {
    expect(() => calculateExactDepreciation({ ...input, ...override })).toThrow();
  }
});
it('uses exact asset salvage value without lossy recurring-decimal residual conversion', () => {
  expect(calculateExactDepreciation({ ...input, cost: '1000', salvageValue: '100', residualPct: '0' }))
    .toMatchObject({ policyDep: '75' });
});
