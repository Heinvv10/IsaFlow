/**
 * T1: the assumptions document (zod bounds, strict keys), scenario overrides
 * deep-merged with lists REPLACING (M6), chain depth ≤ 5 and cycles refused
 * with typed errors (§13.21), I8 empty override = base.
 */
import { describe, it, expect } from 'vitest';
import {
  ThreeWayAssumptionsSchema, type ThreeWayAssumptions,
} from '@/modules/accounting/services/budgets/threeWay/assumptionsSchema';
import {
  MAX_SCENARIO_DEPTH, mergeOverrides, parseStoredDoc, resolveAssumptions, type ChainVersion,
} from '@/modules/accounting/services/budgets/threeWay/assumptionsChain';
import { defaultAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsDefaults';
import { AssumptionChainError, AssumptionsDocError } from '@/modules/accounting/services/budgets/threeWay/errors';
import { runThreeWay } from '@/modules/accounting/services/budgets/threeWay/engine';
import { buckets, input, monthsFrom, pnl, R } from './helpers';

const base = (): ThreeWayAssumptions => {
  const a = defaultAssumptions({ priorYearEnd: '2026-02', entityType: 'pty_ltd', vat: { registered: true, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' } });
  a.capex = [
    { id: 'a', month: '2026-04', amountExVat: R(1000), vatClaimable: true, description: 'A' },
    { id: 'b', month: '2026-05', amountExVat: R(2000), vatClaimable: true, description: 'B' },
  ];
  return a;
};
const manual = <T>(value: T) => ({ value, source: 'manual' as const });

describe('defaultAssumptions', () => {
  it('is a valid document with the spec defaults (30/30/0, insufficient history, SARS top-up)', () => {
    const a = defaultAssumptions({ priorYearEnd: '2026-02', entityType: 'pty_ltd', vat: { registered: false, cadence: 'bi-monthly', alignment: 'odd', basis: 'invoice' } });
    expect(ThreeWayAssumptionsSchema.parse(a)).toEqual(a);
    expect([a.workingCapital.debtorDays.value, a.workingCapital.creditorDays.value, a.workingCapital.inventoryDays.value]).toEqual([30, 30, 0]);
    expect(a.workingCapital.debtorDays.basis).toBe('insufficient history');
    expect(a.incomeTax.topUpMonthOffset.value).toBe(7);
    expect(defaultAssumptions({ priorYearEnd: '2026-06', entityType: 'trust', vat: { registered: false, cadence: 'monthly', alignment: 'odd', basis: 'invoice' } }).incomeTax)
      .toMatchObject({ mode: { value: 'off' }, topUpMonthOffset: { value: 6 } });
  });
});

describe('schema bounds', () => {
  const bad: Array<[string, (a: ThreeWayAssumptions & Record<string, unknown>) => void]> = [
    ['debtor days 366', a => { a.workingCapital.debtorDays.value = 366; }],
    ['creditor days −1', a => { a.workingCapital.creditorDays.value = -1; }],
    ['inventory days 731', a => { a.workingCapital.inventoryDays.value = 731; }],
    ['share 1.01', a => { a.vat.vatableSalesShare.value = 1.01; }],
    ['refund lag 3', a => { (a.vat.refundLagMonths as { value: number }).value = 3; }],
    ['top-up offset 5', a => { (a.incomeTax.topUpMonthOffset as { value: number }).value = 5; }],
    ['month 2026-13', a => { (a.capex[0] as { month: string }).month = '2026-13'; }],
    ['fractional cents', a => { (a.capex[0] as { amountExVat: number }).amountExVat = 10.5; }],
    ['duplicate capex id', a => { (a.capex[1] as { id: string }).id = 'a'; }],
    ['unknown key', a => { a.extra = 1; }],
    ['unknown provenance', a => { (a.minimumCash as { source: string }).source = 'guess'; }],
    ['schemaVersion 2', a => { (a as { schemaVersion: number }).schemaVersion = 2; }],
    ['dividend paid before declared', a => { a.equity.dividends = [{ id: 'd', declaredMonth: '2026-05', paidMonth: '2026-04', amount: 1 }]; }],
    ['loan repaid before drawdown', a => {
      a.loans.planned = [{ id: 'l', description: '', drawdownMonth: '2026-05', principal: 1, annualRatePct: 1, termMonths: 1, firstRepaymentMonth: '2026-04' }];
    }],
  ];
  for (const [name, mutate] of bad) {
    it(`refuses ${name}`, () => {
      const a = base() as ThreeWayAssumptions & Record<string, unknown>;
      mutate(a);
      expect(ThreeWayAssumptionsSchema.safeParse(a).success).toBe(false);
      expect(() => parseStoredDoc(a)).toThrow(AssumptionsDocError);
    });
  }
  it('accepts the edges (365, 730, 0, 1)', () => {
    const a = base();
    a.workingCapital.debtorDays.value = 365; a.workingCapital.inventoryDays.value = 730;
    a.vat.vatableSalesShare.value = 0; a.vat.vatablePurchasesShare.value = 1;
    expect(ThreeWayAssumptionsSchema.safeParse(a).success).toBe(true);
  });
  it('an overrides doc parses; a partial Prov inside it does not', () => {
    expect(parseStoredDoc({ schemaVersion: 1, overrides: { workingCapital: { debtorDays: manual(60) } } })).toEqual(
      { schemaVersion: 1, overrides: { workingCapital: { debtorDays: manual(60) } } });
    expect(() => parseStoredDoc({ schemaVersion: 1, overrides: { workingCapital: { debtorDays: { value: 60 } } } })).toThrow(AssumptionsDocError);
  });
});

describe('mergeOverrides', () => {
  it('deep-merges: one field overridden, its siblings kept (M6)', () => {
    const m = mergeOverrides(base(), { workingCapital: { debtorDays: manual(60) } });
    expect(m.workingCapital).toEqual({ ...base().workingCapital, debtorDays: manual(60) });
    expect(m.vat).toEqual(base().vat);
  });
  it('a Prov is replaced whole (no stale derivedAsAt / basis)', () => {
    const b = base();
    b.workingCapital.creditorDays = { value: 41, source: 'derived', derivedAsAt: '2026-02-28', basis: 'AP ÷ purchases' };
    expect(mergeOverrides(b, { workingCapital: { creditorDays: manual(10) } }).workingCapital.creditorDays).toEqual(manual(10));
  });
  it('lists REPLACE, never element-merge; [] clears', () => {
    const c = [{ id: 'c', month: '2026-06', amountExVat: R(5), vatClaimable: false, description: 'C' }];
    expect(mergeOverrides(base(), { capex: c }).capex).toEqual(c);
    expect(mergeOverrides(base(), { capex: [] }).capex).toEqual([]);
    expect(mergeOverrides(base(), { loans: { existing: [{ loanId: 'x', include: false }] } }).loans)
      .toEqual({ existing: [{ loanId: 'x', include: false }], planned: [] });
  });
  it('does not mutate the base', () => {
    const b = base(); const snapshot = JSON.stringify(b);
    mergeOverrides(b, { workingCapital: { debtorDays: manual(1) }, capex: [] });
    expect(JSON.stringify(b)).toBe(snapshot);
  });
});

function chain(spec: Array<Partial<ChainVersion> & { id: string }>): Map<string, ChainVersion> {
  return new Map(spec.map(v => [v.id, { companyId: 'co', fiscalYear: 2027, kind: 'scenario', basedOnVersionId: null, doc: null, ...v }]));
}
const derived = base();

describe('resolveAssumptions', () => {
  it('I8: an empty override resolves to the base, and the engine output is identical', () => {
    const versions = chain([
      { id: 'orig', kind: 'original', doc: base() },
      { id: 'scn', basedOnVersionId: 'orig', doc: { schemaVersion: 1, overrides: {} } },
    ]);
    const r = resolveAssumptions('scn', versions, derived);
    expect(r.assumptions).toEqual(base());
    expect(r.chain).toEqual(['scn', 'orig']);
    const months = monthsFrom('2026-03', 3);
    const run = (a: ThreeWayAssumptions) => runThreeWay(input({
      months, pnl: months.map(() => pnl({ turnover: 1000 })), opening: buckets({ cash: 5, otherEquity: -5 }), assumptions: a,
    }));
    expect(run(r.assumptions)).toEqual(run(base()));
  });
  it('layers apply root first, target last; a version without a doc is an empty layer', () => {
    const versions = chain([
      { id: 'orig', kind: 'original', doc: null },
      { id: 's1', basedOnVersionId: 'orig', doc: { schemaVersion: 1, overrides: { workingCapital: { debtorDays: manual(50) } } } },
      { id: 's2', basedOnVersionId: 's1', doc: null },
      { id: 's3', basedOnVersionId: 's2', doc: { schemaVersion: 1, overrides: { workingCapital: { debtorDays: manual(90) }, capex: [] } } },
    ]);
    expect(resolveAssumptions('s1', versions, derived).assumptions.workingCapital.debtorDays).toEqual(manual(50));
    const r = resolveAssumptions('s3', versions, derived);
    expect(r.assumptions.workingCapital.debtorDays).toEqual(manual(90));
    expect(r.assumptions.capex).toEqual([]);
    expect(resolveAssumptions('orig', versions, derived).assumptions).toEqual(derived);
  });
  it('a scenario holding a full doc stops the walk', () => {
    const full = base(); full.minimumCash = manual(R(7));
    const versions = chain([{ id: 's', basedOnVersionId: 'missing', doc: full }]);
    expect(resolveAssumptions('s', versions, derived).assumptions).toEqual(full);
  });
  it(`depth ${MAX_SCENARIO_DEPTH} resolves; ${MAX_SCENARIO_DEPTH + 1} is TOO_DEEP`, () => {
    const ids = ['orig', 's1', 's2', 's3', 's4', 's5', 's6'];
    const versions = chain(ids.map((id, i) => (i === 0 ? { id, kind: 'original' as const, doc: base() } : { id, basedOnVersionId: ids[i - 1] as string, doc: null })));
    expect(resolveAssumptions('s5', versions, derived).chain).toHaveLength(6);
    expectChainError(() => resolveAssumptions('s6', versions, derived), 'TOO_DEEP');
  });
  it('refuses a cycle, a missing base, a cross-year or cross-company base, overrides on a non-scenario', () => {
    expectChainError(() => resolveAssumptions('a', chain([{ id: 'a', basedOnVersionId: 'b' }, { id: 'b', basedOnVersionId: 'a' }]), derived), 'CYCLE');
    expectChainError(() => resolveAssumptions('a', chain([{ id: 'a', basedOnVersionId: 'a' }]), derived), 'CYCLE');
    const ov = { schemaVersion: 1 as const, overrides: {} };
    expectChainError(() => resolveAssumptions('a', chain([{ id: 'a', basedOnVersionId: 'gone', doc: ov }]), derived), 'BASE_MISSING');
    expectChainError(() => resolveAssumptions('a', chain([{ id: 'a', basedOnVersionId: null, doc: ov }]), derived), 'BASE_MISSING');
    expectChainError(() => resolveAssumptions('a', chain([{ id: 'a', basedOnVersionId: 'b' }, { id: 'b', kind: 'original', fiscalYear: 2026 }]), derived), 'CROSS_YEAR');
    expectChainError(() => resolveAssumptions('a', chain([{ id: 'a', basedOnVersionId: 'b' }, { id: 'b', kind: 'original', companyId: 'other' }]), derived), 'CROSS_COMPANY');
    expectChainError(() => resolveAssumptions('a', chain([{ id: 'a', kind: 'reforecast', doc: ov }]), derived), 'OVERRIDES_ON_NON_SCENARIO');
    expectChainError(() => resolveAssumptions('zz', chain([]), derived), 'VERSION_NOT_FOUND');
  });
});

function expectChainError(fn: () => unknown, code: AssumptionChainError['code']): void {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(AssumptionChainError);
    expect((e as AssumptionChainError).code).toBe(code);
    return;
  }
  expect.fail(`expected AssumptionChainError ${code}`);
}
