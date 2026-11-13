import { describe, it, expect } from 'vitest';
import { runThreeWay } from '@/modules/accounting/services/budgets/threeWay/engine';
import { parseStoredDoc, mergeOverrides } from '@/modules/accounting/services/budgets/threeWay/assumptionsChain';
import { compareVersions } from '@/modules/accounting/services/budgets/threeWay/compare';
import { MAX_CENTS } from '@/modules/accounting/services/budgets/grid/cents';
import { assumptions, buckets, input, monthsFrom, pnl, R, lookbackMonths } from '../helpers';
import { assertInvariants } from '../invariants';
import { emptyBuckets, emptyPnl } from '@/modules/accounting/services/budgets/threeWay/types';
import { AssumptionsDocError, EngineInputError } from '@/modules/accounting/services/budgets/threeWay/errors';

describe('breaker', () => {
  it('B1 overflow: 15 months of MAX_CENTS turnover — validator accepts, engine must stay exact or refuse', () => {
    const months = monthsFrom('2026-03', 15);
    const p = months.map(() => { const x = emptyPnl(); x.turnover = MAX_CENTS; return x; });
    const opening = emptyBuckets();
    opening.cash = 1; opening.retainedEarnings = -1;
    const inp = input({ months, pnl: p, opening, assumptions: assumptions(months) });
    // Ruling 1 (fix round 1): a value above MAX_VALUE_CENTS (1e13) is refused as RANGE before any arithmetic.
    expect(() => runThreeWay(inp)).toThrow(EngineInputError);
    try { runThreeWay(inp); } catch (e) { expect((e as EngineInputError).code).toBe('RANGE'); }
  });

  it('B2 dividend declared BEFORE the version, paid inside: §13.20 says ignored + warned', () => {
    const months = monthsFrom('2026-03', 3);
    const a = assumptions(months, {}, d => { d.equity.dividends = [{ id: 'd1', declaredMonth: '2026-01', paidMonth: '2026-04', amount: R(10000) }]; });
    const out = runThreeWay(input({ months, pnl: months.map(() => pnl({})), opening: buckets({ cash: 50000, shareCapital: -50000 }), assumptions: a }));
    expect(out.warnings.some(w => w.code === 'outside_months')).toBe(true);
    // Hand: entry ignored → cash stays 50 000, no dividends payable.
    expect([out.months[1]!.closing.cash, out.months[1]!.closing.dividendsPayable]).toEqual([R(50000), 0]);
  });

  it('B2b planned loan drawn BEFORE the version, schedule repays inside: §13.20 ignored', () => {
    const months = monthsFrom('2026-03', 3);
    const a = assumptions(months, {}, d => { d.loans.planned = [{ id: 'L1', description: 'x', drawdownMonth: '2026-01', principal: R(100000), annualRatePct: 10, termMonths: 20, firstRepaymentMonth: '2026-02' }]; });
    const out = runThreeWay(input({ months, pnl: months.map(() => pnl({})), opening: buckets({ cash: 50000, shareCapital: -50000 }), assumptions: a,
      loanSchedules: [{ loanId: 'L1', lines: months.map(m => ({ month: m, principal: R(5000), interest: 0 })) }] }));
    // Hand: the loan never exists in this version (opening loans 0) → it cannot be repaid; loans must not go debit.
    expect(out.months[2]!.closing.loans).toBeLessThanOrEqual(0);
  });

  it('B3 Feb year end with topUpMonthOffset 6 stored: SARS says Sep (7), §13.1', () => {
    const months = monthsFrom('2026-03', 12);
    const a = assumptions(months, {}, d => { d.incomeTax.topUpMonthOffset = { value: 6, source: 'derived' }; });
    const out = runThreeWay(input({ months, pnl: months.map(() => pnl({ taxExpense: 12000 })), opening: buckets({ cash: 500000, incomeTaxPayable: -30000, shareCapital: -470000 }), assumptions: a }));
    const top = out.taxEvents.find(e => e.kind === 'top_up');
    expect(top?.month).toBe('2026-09');
  });

  it('B4 duplicate loanId in loanSchedules is silently collapsed (validator should refuse or sum)', () => {
    const months = monthsFrom('2026-03', 2);
    const a = assumptions(months, {}, d => { d.loans.existing = [{ loanId: 'E1', include: true }]; });
    const sched = (amt: number) => ({ loanId: 'E1', lines: months.map(m => ({ month: m, principal: R(amt), interest: 0 })) });
    let out;
    try {
      out = runThreeWay(input({ months, pnl: months.map(() => pnl({})), opening: buckets({ cash: 100000, loans: -100000 }), assumptions: a, loanSchedules: [sched(1000), sched(2000)] }));
    } catch { return; }
    // Either refused, or both schedules applied: cash 100 000 − 2×3 000 = 94 000
    expect(out.months[1]!.closing.cash).toBe(R(94000));
  });

  it('B5 __proto__ in a stored overrides doc is refused', () => {
    expect(() => parseStoredDoc(JSON.parse('{"schemaVersion":1,"overrides":{"__proto__":{"polluted":1}}}'))).toThrow();
    expect(() => parseStoredDoc(JSON.parse('{"schemaVersion":1,"overrides":{"workingCapital":{"constructor":{"x":1}}}}'))).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('B5b mergeOverrides with a raw __proto__ key does not pollute', () => {
    const months = monthsFrom('2026-03', 1);
    const base = assumptions(months);
    expect(() => mergeOverrides(base, JSON.parse('{"__proto__":{"polluted":1},"workingCapital":{"__proto__":{"polluted":2}}}'))).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('B6 fractional days to 3 dp are refused (ruling 6: 2-decimal precision); 30.12 days of R1000/day = 30 120.00', () => {
    const months = monthsFrom('2026-03', 1);
    const run = (debtorDays: number) => runThreeWay(input({ months, pnl: [pnl({ turnover: 31000 })], opening: buckets({ cash: 1, shareCapital: -1 }), assumptions: assumptions(months, { debtorDays }) }));
    expect(() => run(30.125)).toThrow(AssumptionsDocError);
    expect(run(30.12).months[0]!.closing.receivables).toBe(R(30120));
  });

  it('H1 F3b payment basis, bi-monthly odd, D=31, hand-computed', () => {
    // Apr–May period (odd → ends May). Turnover 10 000 Apr, May; shares 1. D = 31.
    // Apr: AR close = 10000×1.15 × 30/30 → D=31 walks 1 day into Mar (0) → 11 500; receipts 0. 
    // May: AR close = May 11 500 (31 d) → 11 500; receipts = 11 500 (Apr's). VAT on receipts 1 500.
    // Period Apr–May net 1 500, paid June.
    const months = monthsFrom('2026-04', 3);
    const inp = input({ months, pnl: [pnl({ turnover: 10000 }), pnl({ turnover: 10000 }), pnl({})],
      opening: buckets({ cash: 1000, shareCapital: -1000 }), assumptions: assumptions(months, { vat: { cadence: 'bi-monthly', alignment: 'odd', basis: 'payment' }, debtorDays: 31 }) });
    const out = runThreeWay(inp);
    assertInvariants(inp, out);
    expect(out.vatSettlements.map(s => [s.periodEnd, s.net, s.settleMonth])).toEqual([['2026-05', R(1500), '2026-06'], ['2026-07', 145161, '2026-08']]);
    // June: receipts = 11 500 (May's), cash = 1000 + 11 500 + 11 500 − 1 500
    // June: AR close = 1/31 × 11 500 = 370.97 → receipts 11 129.03; VAT in it 1 451.61
    expect(out.months[2]!.closing.cash).toBe(100000 + 1150000 + 1112903 - 150000);
  });

  it('H2 refund lag 2 monthly: input-heavy March refunded in May', () => {
    const months = monthsFrom('2026-03', 3);
    const out = runThreeWay(input({ months, pnl: [pnl({ otherOpex: 10000 }), pnl({}), pnl({})], opening: buckets({ cash: 20000, shareCapital: -20000 }),
      assumptions: assumptions(months, { vat: { cadence: 'monthly' } }, d => { d.vat.refundLagMonths = { value: 2, source: 'manual' }; }) }));
    expect(out.vatSettlements[0]).toMatchObject({ periodEnd: '2026-03', net: -R(1500), settleMonth: '2026-05', settled: true });
    expect(out.months.map(m => m.closing.cash)).toEqual([R(8500), R(8500), R(10000)]);
  });

  it('H3 opening VAT control debit (refund) bi-monthly even, first Mar: period Mar–Apr? no — Feb ends Jan–Feb → due Mar', () => {
    const months = monthsFrom('2026-03', 2);
    const out = runThreeWay(input({ months, pnl: months.map(() => pnl({})), opening: buckets({ cash: 0, vatControl: 2000, shareCapital: -2000 }),
      assumptions: assumptions(months, { vat: { cadence: 'bi-monthly', alignment: 'even' } }, d => { d.vat.refundLagMonths = { value: 1, source: 'manual' }; }) }));
    expect(out.months.map(m => m.closing.cash)).toEqual([R(2000), R(2000)]);
  });

  it('H4 15-month transition year, Feb prior YE: IRP6#1 m6, top-up m7, #2 m15', () => {
    const months = monthsFrom('2026-03', 15);
    const out = runThreeWay(input({ months, pnl: months.map(() => pnl({ taxExpense: 1000 })), opening: buckets({ cash: 100000, incomeTaxPayable: -3000, shareCapital: -97000 }),
      assumptions: assumptions(months) }));
    expect(out.taxEvents).toEqual([
      { month: '2026-08', kind: 'irp6_first', amount: R(7500) },
      { month: '2026-09', kind: 'top_up', amount: R(3000) },
      { month: '2027-05', kind: 'irp6_second', amount: R(7500) },
    ]);
  });

  it('H5 6-month transition year: no IRP6#1, all in month 6', () => {
    const months = monthsFrom('2026-07', 6);
    const out = runThreeWay(input({ months, pnl: months.map(() => pnl({ taxExpense: 1001 })), opening: buckets({ cash: 100000, shareCapital: -100000 }), assumptions: assumptions(months) }));
    expect(out.taxEvents).toEqual([{ month: '2026-12', kind: 'irp6_second', amount: R(6006) }]);
  });

  it('H6 compare: Δ = version − first, Δ% null at first 0', () => {
    const months = monthsFrom('2026-03', 1);
    const mk = (cash: number) => runThreeWay(input({ months, pnl: [pnl({})], opening: buckets({ cash, shareCapital: -cash }), assumptions: assumptions(months) }));
    const c = compareVersions([{ versionId: 'a', name: 'a', output: mk(0) }, { versionId: 'b', name: 'b', output: mk(-100) }]);
    expect(c.versions[1]!.kpis.closingCash).toMatchObject({ delta: R(-100), deltaPct: null, favourable: false });
    const c2 = compareVersions([{ versionId: 'a', name: 'a', output: mk(-200) }, { versionId: 'b', name: 'b', output: mk(-100) }]);
    expect(c2.versions[1]!.kpis.closingCash).toMatchObject({ delta: R(100), deltaPct: 50, favourable: true });
  });

  it('H7 odd cents / vatable share 0.333333 / prime days: invariants', () => {
    const months = monthsFrom('2026-02', 13);
    const inp = (input({ months, pnl: months.map((_, i) => ({ ...emptyPnl(), turnover: 1000003 + i * 7, costOfSales: 333331, otherOpex: -17, payroll: 99999, taxExpense: -3, financeCost: 1 })),
      lookback: lookbackMonths('2025-11', [{ turnover: 7 }, { turnover: 11 }, { turnover: 13, supplierPurchases: 5 }]),
      opening: buckets({ cash: 0.01, inventory: 0.07, retainedEarnings: -0.08 }),
      assumptions: assumptions(months, { vat: { cadence: 'bi-monthly', alignment: 'even', basis: 'payment' }, debtorDays: 97, creditorDays: 53, inventoryDays: 211, statutoryShare: 0.333333 },
        d => { d.vat.vatableSalesShare = { value: 0.333333, source: 'manual' }; d.vat.vatablePurchasesShare = { value: 0.7, source: 'manual' }; d.vat.refundLagMonths = { value: 0, source: 'manual' }; }) }));
    assertInvariants(inp, runThreeWay(inp));
  });
});
