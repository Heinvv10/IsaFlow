/**
 * Budgets P1: a route answers a budget-version refusal with the contract code, whether the service
 * refused it (BudgetVersionError) or the database's backstop did (raw BV001 / BV002 / 23P01 on
 * budget_month_amounts_one_grain, mapped by budgetDbRefusal). Any other error is left for the 500.
 */
import { describe, expect, it } from 'vitest';
import type { NextApiResponse } from 'next';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { BudgetVersionError } from '@/modules/accounting/services/budgets/budgetVersionTypes';

function fakeRes() {
  const out: { status?: number; body?: { error?: { message?: string; details?: { code?: string } } } } = {};
  const res = {
    status(code: number) { out.status = code; return res; },
    json(body: unknown) { out.body = body as typeof out.body; return res; },
    setHeader() { return res; },
  };
  return { res: res as unknown as NextApiResponse, out };
}

const pgError = (code: string, constraint?: string) => Object.assign(new Error('raw database text'), { code, constraint });

describe('respondBudgetVersionError', () => {
  it.each([
    ['BV001', undefined, 409, 'BUDGET_VERSION_LOCKED'],
    ['BV002', undefined, 409, 'BUDGET_VERSION_STATE'],
    ['23P01', 'budget_month_amounts_one_grain', 400, 'BUDGET_GRAIN_CONFLICT'],
  ])('maps a raw %s to %i %s, without the database text', (code, constraint, status, contract) => {
    const { res, out } = fakeRes();
    expect(respondBudgetVersionError(res, pgError(code, constraint))).toBe(true);
    expect([out.status, out.body?.error?.details?.code]).toEqual([status, contract]);
    expect(JSON.stringify(out.body)).not.toContain('raw database text');
  });

  it('answers a typed refusal with its own status and code', () => {
    const { res, out } = fakeRes();
    expect(respondBudgetVersionError(res, new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found'))).toBe(true);
    expect([out.status, out.body?.error?.details?.code]).toEqual([404, 'BUDGET_VERSION_NOT_FOUND']);
  });

  it('leaves any other error (an exclusion on another constraint, a plain failure) unanswered', () => {
    for (const err of [pgError('23P01', 'fiscal_periods_no_overlap'), pgError('42P01'), new Error('boom')]) {
      const { res, out } = fakeRes();
      expect(respondBudgetVersionError(res, err)).toBe(false);
      expect(out.status).toBeUndefined();
    }
  });
});
