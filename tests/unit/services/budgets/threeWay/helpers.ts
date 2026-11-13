/**
 * Fixture builders for the three-way engine tests. Rands in, cents out (R()).
 */
import { expect } from 'vitest';
import { defaultAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsDefaults';
import type { ThreeWayAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsSchema';
import { addMonths } from '@/modules/accounting/services/budgets/threeWay/months';
import {
  BUCKET_KEYS, emptyBuckets, emptyPnl,
  type BucketKey, type Buckets, type EngineInput, type EngineOutput, type LookbackMonth, type PnlBand, type PnlMonth,
} from '@/modules/accounting/services/budgets/threeWay/types';
import type { EntityTypeCode } from '@/lib/entityTypes';

/** Rands → cents. */
export const R = (rand: number): number => Math.round(rand * 100) || 0;

export function buckets(rands: Partial<Record<BucketKey, number>>): Buckets {
  const b = emptyBuckets();
  for (const [k, v] of Object.entries(rands)) b[k as BucketKey] = R(v as number);
  return b;
}

export function pnl(rands: Partial<Record<PnlBand, number>>): PnlMonth {
  const p = emptyPnl();
  for (const [k, v] of Object.entries(rands)) p[k as PnlBand] = R(v as number);
  return p;
}

export function monthsFrom(first: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => addMonths(first, i));
}

export function lookbackMonths(first: string, rands: Array<Partial<Omit<LookbackMonth, 'month'>>>): LookbackMonth[] {
  return rands.map((r, i) => ({
    month: addMonths(first, i),
    turnover: R(r.turnover ?? 0), costOfSales: R(r.costOfSales ?? 0), supplierPurchases: R(r.supplierPurchases ?? 0),
  }));
}

export interface VatOpt { cadence?: 'monthly' | 'bi-monthly'; alignment?: 'odd' | 'even'; basis?: 'invoice' | 'payment' }

/** Defaults (not VAT-registered unless `vat` given; D = C = I = 0), then the patch. */
export function assumptions(
  months: readonly string[],
  opts: { entityType?: EntityTypeCode; vat?: VatOpt; debtorDays?: number; creditorDays?: number; inventoryDays?: number; statutoryShare?: number } = {},
  patch: (a: ThreeWayAssumptions) => void = () => undefined,
): ThreeWayAssumptions {
  const a = defaultAssumptions({
    priorYearEnd: addMonths(months[0] as string, -1),
    entityType: opts.entityType ?? 'pty_ltd',
    vat: opts.vat
      ? { registered: true, cadence: opts.vat.cadence ?? 'monthly', alignment: opts.vat.alignment ?? 'odd', basis: opts.vat.basis ?? 'invoice' }
      : { registered: false, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' },
  });
  const manual = <T>(value: T) => ({ value, source: 'manual' as const });
  a.workingCapital.debtorDays = manual(opts.debtorDays ?? 0);
  a.workingCapital.creditorDays = manual(opts.creditorDays ?? 0);
  a.workingCapital.inventoryDays = manual(opts.inventoryDays ?? 0);
  a.payroll.statutoryShare = manual(opts.statutoryShare ?? 0);
  patch(a);
  return a;
}

export function input(p: {
  months: string[]; pnl: PnlMonth[]; opening: Buckets; assumptions: ThreeWayAssumptions;
  lookback?: LookbackMonth[]; entityType?: EntityTypeCode; loanSchedules?: EngineInput['loanSchedules'];
  checks?: EngineInput['checks'];
}): EngineInput {
  return {
    months: p.months,
    entityType: p.entityType ?? 'pty_ltd',
    pnl: p.pnl,
    lookback: p.lookback ?? [],
    opening: { asAt: '2000-01-01', provisional: false, buckets: p.opening },
    assumptions: p.assumptions,
    loanSchedules: p.loanSchedules ?? [],
    checks: p.checks,
  };
}

/** Every bucket of month i equals `rands` (unlisted buckets 0). */
export function expectMonth(out: EngineOutput, i: number, rands: Partial<Record<BucketKey, number>>): void {
  const actual = out.months[i]?.closing;
  expect(actual, `month ${i} exists`).toBeDefined();
  const want = buckets(rands);
  for (const k of BUCKET_KEYS) expect([out.months[i]?.month, k, actual?.[k]]).toEqual([out.months[i]?.month, k, want[k]]);
  expect(out.months[i]?.balanceSheet.check).toBe(0);
}
