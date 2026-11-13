/**
 * P6 PR C: every typed refusal the three-way service or engine can throw is a typed 4xx with its
 * contract code (never a 500), and anything else is left to the error handler.
 */
import { describe, expect, it } from 'vitest';
import type { NextApiResponse } from 'next';
import { respondThreeWayError } from '@/lib/budgetThreeWayResponse';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';
import {
  AssumptionChainError, AssumptionsDocError, CompareInputError, EngineInputError, OpeningUnbalancedError, UnbalancedPostingError,
} from '@/modules/accounting/services/budgets/threeWay/errors';
import { AssumptionsStaleError, threeWayInputError } from '@/modules/accounting/services/budgets/threeWay/serviceErrors';

function answer(err: unknown): { handled: boolean; status?: number; details?: Record<string, unknown> } {
  const out: { status?: number; body?: { error?: { details?: Record<string, unknown> } } } = {};
  const res = {
    setHeader: () => res,
    status(c: number) { out.status = c; return res; },
    json(b: typeof out.body) { out.body = b; return res; },
  } as unknown as NextApiResponse;
  const handled = respondThreeWayError(res, err);
  return { handled, status: out.status, details: out.body?.error?.details };
}

describe('respondThreeWayError', () => {
  it.each([
    [new AssumptionsStaleError('2026-11-13T05:00:00.123456Z'), 409, { code: 'BUDGET_ASSUMPTIONS_STALE', currentUpdatedAt: '2026-11-13T05:00:00.123456Z' }],
    [threeWayInputError('x'), 400, { code: 'BUDGET_THREE_WAY_INPUT' }],
    [new AssumptionChainError('CROSS_YEAR', 'x', ['a', 'b']), 400, { code: 'BUDGET_SCENARIO_CHAIN', reason: 'CROSS_YEAR', path: ['a', 'b'] }],
    [new AssumptionsDocError([{ path: 'vat', message: 'bad' }]), 400, { code: 'BUDGET_ASSUMPTIONS_INVALID', issues: [{ path: 'vat', message: 'bad' }] }],
    [new OpeningUnbalancedError(250), 409, { code: 'BUDGET_OPENING_UNBALANCED', differenceCents: 250 }],
    [new EngineInputError('RANGE', 'too big'), 422, { code: 'BUDGET_THREE_WAY_RANGE', reason: 'RANGE' }],
    [new EngineInputError('LOAN_SCHEDULE', 'x'), 422, { code: 'BUDGET_THREE_WAY_ENGINE_INPUT', reason: 'LOAN_SCHEDULE' }],
    [new EngineInputError('MONTHS', 'x'), 422, { code: 'BUDGET_THREE_WAY_ENGINE_INPUT', reason: 'MONTHS' }],
    [new CompareInputError('MONTHS', 'x'), 422, { code: 'BUDGET_THREE_WAY_ENGINE_INPUT', reason: 'MONTHS' }],
    [new BudgetVersionError('BUDGET_VERSION_LOCKED', 'x'), 409, { code: 'BUDGET_VERSION_LOCKED' }],
    [new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'x'), 404, { code: 'BUDGET_VERSION_NOT_FOUND' }],
    [Object.assign(new Error('db'), { code: 'BV001' }), 409, { code: 'BUDGET_VERSION_LOCKED' }],
  ])('%o → %i', (err, status, details) => {
    expect(answer(err)).toEqual({ handled: true, status, details });
  });

  it('an engine bug (an unbalanced posting) or a plain error is not answered here (500 from the handler)', () => {
    expect(answer(new UnbalancedPostingError('sales', '2026-03', 1)).handled).toBe(false);
    expect(answer(new RangeError('x')).handled).toBe(false);
  });
});
