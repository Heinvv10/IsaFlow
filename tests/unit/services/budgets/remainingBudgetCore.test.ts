/**
 * Budgets P5 T4 (spec §3a): the pure core of remaining budget. Grain mapping, "No budget" (null)
 * versus a budgeted zero, committed per PO line floored at zero, remaining = budget − actual −
 * committed, in cents.
 */
import { describe, expect, it } from 'vitest';
import {
  computeRemaining,
  memberOnGrain,
  type RemainingInputs,
  type RemainingKey,
} from '@/modules/accounting/services/budgets/remainingBudgetCore';

const V = 'v-27';
const key = (over: Partial<RemainingKey> = {}): RemainingKey => ({
  glAccountId: 'rent', cc1Id: null, cc2Id: null, buId: null, month: '2026-04', ...over,
});
const budget = (over: Partial<RemainingInputs['budgets'][number]> = {}) => ({
  versionId: V, glAccountId: 'rent', month: '2026-04', cc1Id: null, cc2Id: null, buId: null, amount: 1000, ...over,
});
const actual = (grain: 'company' | 'cc1' | 'cc2' | 'bu', accountId: string, memberId: string | null, amount: number, month = '2026-04') =>
  ({ grain, accountId, month, memberId, amount });
const item = (over: Partial<RemainingInputs['commitments'][number]> = {}) => ({
  poItemId: 'pi-1', glAccountId: 'rent', month: '2026-04', cc1Id: null, cc2Id: null, buId: null, lineTotal: 100, billed: 0, ...over,
});
const inputs = (over: Partial<RemainingInputs> = {}): RemainingInputs => ({
  versionOf: () => V,
  grains: new Map([[`${V}|rent`, 'company']]),
  budgets: [budget()],
  actuals: [],
  commitments: [],
  ...over,
});

describe('memberOnGrain', () => {
  it('keeps the grain\'s dimension and drops the rest; a missing grain dimension is the unassigned slice', () => {
    const dims = { cc1Id: 'c1', cc2Id: 'c2', buId: 'b1' };
    expect(memberOnGrain(dims, 'company')).toEqual({ member: null, unassigned: false });
    expect(memberOnGrain(dims, 'cc1')).toEqual({ member: 'c1', unassigned: false });
    expect(memberOnGrain(dims, 'cc2')).toEqual({ member: 'c2', unassigned: false });
    expect(memberOnGrain(dims, 'bu')).toEqual({ member: 'b1', unassigned: false });
    expect(memberOnGrain({ cc1Id: 'c1', cc2Id: null, buId: null }, 'bu')).toEqual({ member: null, unassigned: true });
  });
});

describe('computeRemaining', () => {
  it('company grain: budget − actual − committed', () => {
    const [r] = computeRemaining([key()], inputs({
      actuals: [actual('company', 'rent', null, 250.1)],
      commitments: [item({ lineTotal: 100.05 })],
    }));
    expect(r).toMatchObject({ grain: 'company', versionId: V, budget: 1000, actual: 250.1, committed: 100.05, remaining: 649.85, unassigned: false });
  });

  it('a budgeted zero is a budget (0, not null), so remaining goes negative', () => {
    const [r] = computeRemaining([key()], inputs({ budgets: [budget({ amount: 0 })], actuals: [actual('company', 'rent', null, 5)] }));
    expect(r!.budget).toBe(0);
    expect(r!.remaining).toBe(-5);
  });

  it('no primary version → budget null ("No budget"); actual and committed still reported', () => {
    const [r] = computeRemaining([key()], inputs({
      versionOf: () => null, actuals: [actual('company', 'rent', null, 7)], commitments: [item({ lineTotal: 3 })],
    }));
    expect(r).toMatchObject({ versionId: null, grain: null, budget: null, remaining: null, actual: 7, committed: 3 });
  });

  it('no budget row for the slice and month → null, even when the account has rows elsewhere', () => {
    const [r] = computeRemaining([key({ month: '2026-05' })], inputs());
    expect(r!.budget).toBeNull();
    expect(r!.remaining).toBeNull();
    expect(r!.grain).toBe('company');
  });

  it('dimension grain: the line maps onto the grain; a line without the grain dimension is unassigned → null', () => {
    const grains = new Map([[`${V}|rent`, 'cc1' as const]]);
    const budgets = [budget({ cc1Id: 'ct', amount: 500 }), budget({ cc1Id: 'dbn', amount: 300 })];
    const actuals = [actual('cc1', 'rent', 'ct', 120), actual('cc1', 'rent', 'dbn', 50), actual('cc1', 'rent', null, 9)];
    const commitments = [item({ cc1Id: 'ct', buId: 'ops', lineTotal: 30 }), item({ poItemId: 'pi-2', lineTotal: 4 })];
    const [ct, bare, other] = computeRemaining(
      [key({ cc1Id: 'ct', buId: 'ops' }), key({ buId: 'ops' }), key({ cc1Id: 'dbn', cc2Id: 'p1' })],
      inputs({ grains, budgets, actuals, commitments }),
    );
    expect(ct).toMatchObject({ grain: 'cc1', slice: { cc1Id: 'ct', cc2Id: null, buId: null }, budget: 500, actual: 120, committed: 30, remaining: 350 });
    expect(bare).toMatchObject({ grain: 'cc1', unassigned: true, slice: { cc1Id: null, cc2Id: null, buId: null }, budget: null, actual: 9, committed: 4, remaining: null });
    expect(other).toMatchObject({ budget: 300, actual: 50, committed: 0, remaining: 250 });
  });

  it('committed is per PO line, floored at zero (an over-billed line never offsets another)', () => {
    const [r] = computeRemaining([key()], inputs({
      commitments: [item({ lineTotal: 100, billed: 40 }), item({ poItemId: 'pi-2', lineTotal: 50, billed: 80 })],
    }));
    expect(r!.committed).toBe(60);
  });

  it('only the key\'s account and month count; another grain\'s actual rows are ignored', () => {
    const [r] = computeRemaining([key()], inputs({
      actuals: [actual('company', 'rent', null, 10), actual('company', 'rent', null, 99, '2026-05'), actual('company', 'wages', null, 99),
        actual('cc1', 'rent', 'ct', 99)],
      commitments: [item({ month: '2026-05' }), item({ glAccountId: 'wages' })],
    }));
    expect(r).toMatchObject({ actual: 10, committed: 0, remaining: 990 });
  });

  it('answers in input order, duplicates included', () => {
    const out = computeRemaining([key(), key({ month: '2026-05' }), key()], inputs());
    expect(out.map((r) => r.key.month)).toEqual(['2026-04', '2026-05', '2026-04']);
  });
});
