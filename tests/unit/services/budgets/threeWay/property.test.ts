/**
 * T7 property test: 500 seeded random inputs; I1–I4 hold for every one
 * (assertInvariants replays the ledger independently). Mutation M9 (a
 * residual replaced by an independently rounded figure) turns this red.
 */
import { describe, it, expect } from 'vitest';
import { runThreeWay } from '@/modules/accounting/services/budgets/threeWay/engine';
import { ThreeWayAssumptionsSchema } from '@/modules/accounting/services/budgets/threeWay/assumptionsSchema';
import { addMonths } from '@/modules/accounting/services/budgets/threeWay/months';
import { BUCKET_KEYS, PNL_BANDS, emptyBuckets, emptyPnl, type EngineInput, type PnlMonth } from '@/modules/accounting/services/budgets/threeWay/types';
import { ENTITY_TYPE_CODES } from '@/lib/entityTypes';
import { assumptions, monthsFrom } from './helpers';
import { assertInvariants } from './invariants';

/** mulberry32: small, seeded, deterministic. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function caseFor(seed: number): EngineInput {
  const rnd = prng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T;
  const share = () => pick([0, 1, 0.5, Math.round(rnd() * 1e6) / 1e6]);
  const days = (max: number) => pick([0, int(0, max), Math.round(rnd() * max * 100) / 100]);
  const money = (max: number) => int(0, max);

  const n = int(1, 15);
  const months = monthsFrom(`${int(2025, 2030)}-${String(int(1, 12)).padStart(2, '0')}`, n);
  const at = (k: number) => addMonths(months[0] as string, k);
  const pnl: PnlMonth[] = months.map(() => {
    const p = emptyPnl();
    for (const b of PNL_BANDS) p[b] = rnd() < 0.2 ? 0 : money(rnd() < 0.1 ? 5_000_000_000 : 50_000_000) * (rnd() < 0.05 ? -1 : 1);
    return p;
  });
  const lookLen = int(0, 14);
  const lookback = Array.from({ length: lookLen }, (_, i) => ({
    month: addMonths(months[0] as string, i - lookLen),
    turnover: money(40_000_000), costOfSales: money(20_000_000), supplierPurchases: money(30_000_000),
  }));
  const opening = emptyBuckets();
  for (const k of BUCKET_KEYS) if (k !== 'retainedEarnings' && rnd() < 0.6) opening[k] = money(90_000_000) * (rnd() < 0.5 ? -1 : 1);
  opening.retainedEarnings = -BUCKET_KEYS.reduce((s, k) => s + opening[k], 0);

  const registered = rnd() < 0.7;
  const a = assumptions(months, {
    entityType: pick(ENTITY_TYPE_CODES),
    vat: registered ? { cadence: pick(['monthly', 'bi-monthly'] as const), alignment: pick(['odd', 'even'] as const), basis: pick(['invoice', 'payment'] as const) } : undefined,
    debtorDays: days(365), creditorDays: days(365), inventoryDays: days(730), statutoryShare: share(),
  }, d => {
    d.vat.vatableSalesShare = { value: share(), source: 'manual' };
    d.vat.vatablePurchasesShare = { value: share(), source: 'manual' };
    d.vat.refundLagMonths = { value: pick([0, 1, 2] as const), source: 'manual' };
    d.incomeTax.topUpMonthOffset = { value: pick([6, 7] as const), source: 'manual' };
    if (rnd() < 0.2) d.incomeTax.mode = { value: 'off', source: 'manual' };
    d.capex = Array.from({ length: int(0, 3) }, (_, i) => ({
      id: `c${i}`, month: at(int(-2, n + 1)), amountExVat: money(30_000_000), vatClaimable: rnd() < 0.5, description: '',
    }));
    d.loans.planned = Array.from({ length: int(0, 2) }, (_, i) => {
      const dm = int(-1, n);
      return { id: `p${i}`, description: '', drawdownMonth: at(dm), principal: money(50_000_000) + 1, annualRatePct: 10, termMonths: 24, firstRepaymentMonth: at(dm + int(0, 3)) };
    });
    d.loans.existing = [{ loanId: 'e0', include: rnd() < 0.7 }, { loanId: 'e1', include: rnd() < 0.5 }];
    d.equity.shareIssues = Array.from({ length: int(0, 2) }, (_, i) => ({ id: `s${i}`, month: at(int(-1, n)), amount: money(10_000_000) + 1 }));
    d.equity.dividends = Array.from({ length: int(0, 2) }, (_, i) => {
      const dm = int(-2, n);
      return { id: `d${i}`, declaredMonth: at(dm), paidMonth: at(dm + int(0, 4)), amount: money(10_000_000) + 1 };
    });
  });
  const loanSchedules = [...a.loans.planned.map(p => p.id), 'e0', 'e1']
    .filter(() => rnd() < 0.85)
    .map(loanId => ({ loanId, lines: Array.from({ length: int(0, n + 3) }, (_, i) => ({ month: at(i - 1), principal: money(2_000_000), interest: money(500_000) })) }));
  return {
    months, entityType: a.incomeTax.mode.value === 'off' ? 'pty_ltd' : pick(ENTITY_TYPE_CODES), pnl, lookback,
    opening: { asAt: '2000-01-01', provisional: rnd() < 0.2, buckets: opening }, assumptions: a, loanSchedules,
    checks: rnd() < 0.5 ? { assetRegisterDepreciation: months.map(() => money(100_000)) } : undefined,
  };
}

describe('property: I1–I4 over 500 seeded random inputs', () => {
  it('every case balances, reconciles and replays', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const inp = caseFor(seed);
      expect(ThreeWayAssumptionsSchema.safeParse(inp.assumptions).success, `seed ${seed} schema`).toBe(true);
      assertInvariants(inp, runThreeWay(inp), `seed ${seed}`);
    }
  });
});
