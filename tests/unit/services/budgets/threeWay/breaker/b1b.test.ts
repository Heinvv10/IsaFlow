import { it, expect } from 'vitest';
import { runThreeWay } from '@/modules/accounting/services/budgets/threeWay/engine';
import { MAX_CENTS } from '@/modules/accounting/services/budgets/grid/cents';
import { MAX_VALUE_CENTS } from '@/modules/accounting/services/budgets/threeWay/ratios';
import { EngineInputError } from '@/modules/accounting/services/budgets/threeWay/errors';
import { assumptions, input, monthsFrom } from '../helpers';
import { assertInvariants } from '../invariants';
import { emptyBuckets, emptyPnl } from '@/modules/accounting/services/budgets/threeWay/types';

// Ruling 1 (fix round 1): the per-value cap is MAX_VALUE_CENTS (1e13); MAX_CENTS is refused as RANGE.
const run = (turnover: number) => {
  const months = monthsFrom('2026-03', 15);
  const p = months.map(() => { const x = emptyPnl(); x.turnover = turnover; x.otherOpex = 123457; return x; });
  const opening = emptyBuckets(); opening.cash = 3; opening.retainedEarnings = -3;
  const inp = input({ months, pnl: p, opening, assumptions: assumptions(months, { vat: { cadence: 'monthly' }, debtorDays: 365 }) });
  return { inp, run: () => runThreeWay(inp) };
};
it('B1b overflow invariants at the cap (VAT on, payroll, D=365)', () => {
  const c = run(MAX_VALUE_CENTS);
  assertInvariants(c.inp, c.run());
});
it('B1b MAX_CENTS turnover is refused as RANGE', () => {
  const c = run(MAX_CENTS);
  expect(c.run).toThrow(EngineInputError);
  try { c.run(); } catch (e) { expect((e as EngineInputError).code).toBe('RANGE'); }
});
