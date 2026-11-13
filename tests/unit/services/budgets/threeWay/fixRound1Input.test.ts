/**
 * Fix round 1, input bounds (items 1, 5, 8, 13): per-value and total caps keep
 * every sum inside 2^53; accumulations re-check (RANGE); loan-schedule ids are
 * unique and disjoint from planned ids; opening.asAt and entityType are
 * validated; list lengths are capped.
 */
import { describe, it, expect } from 'vitest';
import { runThreeWay } from '@/modules/accounting/services/budgets/threeWay/engine';
import { closingFromDays } from '@/modules/accounting/services/budgets/threeWay/daysMethod';
import { applyPosting, post } from '@/modules/accounting/services/budgets/threeWay/postings';
import { provisionalTaxSchedule } from '@/modules/accounting/services/budgets/threeWay/statutorySchedule';
import { ThreeWayAssumptionsSchema } from '@/modules/accounting/services/budgets/threeWay/assumptionsSchema';
import { EngineInputError } from '@/modules/accounting/services/budgets/threeWay/errors';
import { addMonths } from '@/modules/accounting/services/budgets/threeWay/months';
import { MAX_TOTAL_CENTS, MAX_VALUE_CENTS } from '@/modules/accounting/services/budgets/threeWay/ratios';
import { PNL_BANDS, emptyBuckets, emptyPnl, type EngineInput } from '@/modules/accounting/services/budgets/threeWay/types';
import { assumptions, buckets, input, lookbackMonths, monthsFrom, pnl, R } from './helpers';

const MAX = Number.MAX_SAFE_INTEGER;

function expectRefused(fn: () => unknown, code: EngineInputError['code']): void {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(EngineInputError);
    expect((e as EngineInputError).code).toBe(code);
    return;
  }
  expect.fail(`expected EngineInputError ${code}`);
}

const months = monthsFrom('2026-03', 3);
const base = (patch: (i: EngineInput) => void = () => undefined): EngineInput => {
  const i = input({ months, pnl: months.map(() => pnl({})), opening: buckets({ cash: 100, shareCapital: -100 }), assumptions: assumptions(months) });
  patch(i);
  return i;
};

describe('item 1: caps', () => {
  it('the caps leave 2^53 headroom (15 months of every flow at the cap fit 4× over)', () => {
    expect(MAX_VALUE_CENTS).toBe(10_000_000_000_000);
    expect(MAX_TOTAL_CENTS).toBe(1_000_000_000_000_000);
    expect(MAX_TOTAL_CENTS * 4).toBeLessThan(MAX);
  });
  it('a value one cent over MAX_VALUE_CENTS is RANGE; at the cap it runs', () => {
    expectRefused(() => runThreeWay(base(i => { (i.pnl[0] as { turnover: number }).turnover = MAX_VALUE_CENTS + 1; })), 'RANGE');
    expectRefused(() => runThreeWay(base(i => { i.opening.buckets.cash = -(MAX_VALUE_CENTS + 1); i.opening.buckets.shareCapital = MAX_VALUE_CENTS + 1; })), 'RANGE');
    expect(runThreeWay(base(i => { (i.pnl[0] as { turnover: number }).turnover = MAX_VALUE_CENTS; })).months[2]?.closing.cash)
      .toBe(R(100) + MAX_VALUE_CENTS);
  });
  it('Σ|all money| above MAX_TOTAL_CENTS is RANGE (15 months × 8 bands at the cap = 1.2e15)', () => {
    const ms = monthsFrom('2026-03', 15);
    const full = () => { const p = emptyPnl(); for (const b of PNL_BANDS) p[b] = MAX_VALUE_CENTS; return p; };
    expectRefused(() => runThreeWay(input({ months: ms, pnl: ms.map(full), opening: emptyBuckets(), assumptions: assumptions(ms) })), 'RANGE');
  });
  it('the schema caps document money at MAX_VALUE_CENTS', () => {
    const a = assumptions(months, {}, d => { d.equity.shareIssues = [{ id: 's', month: '2026-03', amount: MAX_VALUE_CENTS + 1 }]; });
    expect(ThreeWayAssumptionsSchema.safeParse(a).success).toBe(false);
  });
  it('applyPosting, post, closingFromDays and the FY tax sum re-check safe integers', () => {
    const b = emptyBuckets(); b.cash = MAX - 5;
    expectRefused(() => applyPosting(b, { month: '2026-03', step: 'receipts', cashGroup: 'cash_received_from_customers',
      lines: [{ account: 'cash', amount: 10 }, { account: 'receivables', amount: -10 }] }), 'RANGE');
    expectRefused(() => post('2026-03', 'sales', null, [
      { account: 'receivables', amount: MAX }, { account: 'vatControl', amount: MAX },
      { account: 'pnl.turnover', amount: -MAX }, { account: 'retainedEarnings', amount: -MAX },
    ]), 'RANGE');
    expectRefused(() => closingFromDays(62, [MAX, MAX], [31, 31], 1), 'RANGE');
    expectRefused(() => provisionalTaxSchedule({ months: ['2026-03', '2026-04'], taxExpense: [MAX, MAX], openingTaxPayable: 0, topUpOffset: 7 }), 'RANGE');
  });
});

describe('item 5: loan schedule ids', () => {
  it('a duplicate loanId in loanSchedules is refused', () => {
    expectRefused(() => runThreeWay(base(i => {
      i.loanSchedules = [{ loanId: 'E1', lines: [] }, { loanId: 'E1', lines: [] }];
    })), 'LOAN_SCHEDULE');
  });
  it('an existing loanId equal to a planned id is refused', () => {
    expectRefused(() => runThreeWay(base(i => {
      i.assumptions.loans.existing = [{ loanId: 'X', include: true }];
      i.assumptions.loans.planned = [{ id: 'X', description: '', drawdownMonth: '2026-03', principal: 1, annualRatePct: 1, termMonths: 1, firstRepaymentMonth: '2026-04' }];
    })), 'LOAN_SCHEDULE');
  });
});

describe('item 8: opening.asAt and entityType', () => {
  it('refuses a malformed or impossible as-at date', () => {
    for (const asAt of ['2026-02-29', '28-02-2026', '2026-02', '2026-13-01']) {
      expectRefused(() => runThreeWay(base(i => { i.opening.asAt = asAt; })), 'OPENING');
    }
    expect(runThreeWay(base(i => { i.opening.asAt = '2028-02-29'; })).opening.asAt).toBe('2028-02-29');
  });
  it('refuses an unknown entity type', () => {
    expectRefused(() => runThreeWay(base(i => { (i as { entityType: string }).entityType = 'company'; })), 'ENTITY');
  });
});

describe('item 13: list caps', () => {
  it('lookback ≤ 36 months', () => {
    const lb = (n: number) => lookbackMonths(addMonths('2026-03', -n), Array.from({ length: n }, () => ({})));
    expect(runThreeWay(base(i => { i.lookback = lb(36); })).months).toHaveLength(3);
    expectRefused(() => runThreeWay(base(i => { i.lookback = lb(37); })), 'LOOKBACK');
  });
  it('loanSchedules[].lines ≤ months; loanSchedules ≤ 200', () => {
    const lines = (n: number) => Array.from({ length: n }, (_, k) => ({ month: addMonths('2026-03', k), principal: 0, interest: 0 }));
    expect(runThreeWay(base(i => { i.loanSchedules = [{ loanId: 'a', lines: lines(3) }]; })).months).toHaveLength(3);
    expectRefused(() => runThreeWay(base(i => { i.loanSchedules = [{ loanId: 'a', lines: lines(4) }]; })), 'LOAN_SCHEDULE');
    const many = (n: number) => Array.from({ length: n }, (_, k) => ({ loanId: `l${k}`, lines: [] }));
    expect(runThreeWay(base(i => { i.loanSchedules = many(200); })).months).toHaveLength(3);
    expectRefused(() => runThreeWay(base(i => { i.loanSchedules = many(201); })), 'LOAN_SCHEDULE');
  });
  it('opening.unmapped ≤ 2000', () => {
    const um = (n: number) => Array.from({ length: n }, (_, k) => ({ accountCode: `${k}`, bucket: 'otherEquity' as const, balance: 0 }));
    expect(runThreeWay(base(i => { i.opening.unmapped = um(2000); })).months).toHaveLength(3);
    expectRefused(() => runThreeWay(base(i => { i.opening.unmapped = um(2001); })), 'OPENING');
  });
});
