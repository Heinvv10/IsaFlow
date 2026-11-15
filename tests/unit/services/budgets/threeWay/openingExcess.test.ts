/**
 * Opening working-capital excess (spec §13.26, Hein 2026-11-15, "spread + warn").
 *
 * An opening AR (AP) above the days level of month 1 is collected (paid) in
 * equal slices over the version's months, never all in month 1. A shortfall
 * keeps the residual behaviour. Derived days at the 365-day cap are warned.
 *
 * Fixture: 12 months from 2026-03, not VAT-registered, 11 lookback months.
 * 365 days from any month of the version cover exactly 12 whole months (no
 * leap February in the windows), so the days level is 12 × the monthly flow.
 */
import { describe, it, expect } from 'vitest';
import { runThreeWay } from '@/modules/accounting/services/budgets/threeWay/engine';
import type { ThreeWayAssumptions } from '@/modules/accounting/services/budgets/threeWay/assumptionsSchema';
import { assertInvariants } from './invariants';
import { assumptions, buckets, input, lookbackMonths, monthsFrom, pnl, R } from './helpers';

const months = monthsFrom('2026-03', 12);
const lookback = lookbackMonths('2025-04', Array.from({ length: 11 }, () => ({ turnover: 10000, supplierPurchases: 5000 })));
const derived365 = (a: ThreeWayAssumptions) => {
  a.workingCapital.debtorDays = { value: 365, source: 'derived', derivedAsAt: '2026-02-28', basis: 'trailing' };
  a.workingCapital.creditorDays = { value: 365, source: 'derived', derivedAsAt: '2026-02-28', basis: 'trailing' };
};

function run(opening: Parameters<typeof buckets>[0], patch: (a: ThreeWayAssumptions) => void = derived365, vat = false) {
  const inp = input({
    months,
    pnl: months.map(() => pnl({ turnover: 10000, otherOpex: 5000 })),
    lookback,
    opening: buckets(opening),
    assumptions: assumptions(months, vat ? { vat: { cadence: 'monthly' } } : {}, patch),
  });
  return { inp, out: runThreeWay(inp) };
}

const receipts = (o: ReturnType<typeof runThreeWay>) => o.months.map(m => m.cashFlow.direct.cash_received_from_customers);
const payments = (o: ReturnType<typeof runThreeWay>) => o.months.map(m => m.cashFlow.direct.cash_paid_to_suppliers);

describe('Demo-like opening: AR 600 000 and AP 300 000 against R10 000 / R5 000 a month, days capped at 365', () => {
  const { inp, out } = run({ receivables: 600000, payables: -300000, otherEquity: -300000 });

  it('month-1 receipts are sales + 1/12 of the excess (50 000), never the whole 480 000 excess', () => {
    expect(receipts(out)).toEqual(months.map(() => R(50000)));
  });

  it('AR unwinds 560 000 … 120 000: days level + the excess left', () => {
    expect(out.months.map(m => m.closing.receivables)).toEqual(months.map((_, i) => R(120000 + 40000 * (11 - i))));
  });

  it('FY receipts = opening + sales − closing AR (unchanged in total)', () => {
    const total = receipts(out).reduce((s, v) => s + v, 0);
    expect(total).toBe(R(600000) + R(120000) - (out.months[11]?.closing.receivables ?? NaN));
    expect(total).toBe(R(600000));
  });

  it('payables mirror: payments 25 000 a month, AP unwinds to the days level', () => {
    expect(payments(out)).toEqual(months.map(() => -R(25000)));
    expect(out.months.map(m => -m.closing.payables)).toEqual(months.map((_, i) => R(60000 + 20000 * (11 - i))));
  });

  it('balances, ties direct = indirect, and replays (I1–I4)', () => {
    assertInvariants(inp, out, 'excess');
  });

  it('warns that debtor and creditor days are capped, with the excess and the months it is spread over', () => {
    expect(out.warnings.filter(w => w.code === 'days_capped')).toEqual([
      { code: 'days_capped', series: 'receivables', days: 365, excess: R(480000), months: 12 },
      { code: 'days_capped', series: 'payables', days: 365, excess: R(240000), months: 12 },
    ]);
  });
});

describe('excess with an uneven split: slices sum to the excess exactly', () => {
  it('excess 100 000.07 over 12 months: AR reaches the days level in the last month to the cent', () => {
    const { inp, out } = run({ receivables: 220000.07, otherEquity: -220000.07 });
    expect(out.months[11]?.closing.receivables).toBe(R(120000));
    expect(receipts(out).reduce((s, v) => s + v, 0)).toBe(R(220000.07));
    const slices = receipts(out).map(r => r - R(10000));
    expect(Math.max(...slices) - Math.min(...slices)).toBeLessThanOrEqual(1);
    assertInvariants(inp, out, 'uneven');
  });

  it('VAT-registered (invoice basis): the spread still balances and ties', () => {
    const { inp, out } = run({ receivables: 600000, payables: -300000, otherEquity: -300000 }, derived365, true);
    const first = out.months[0];
    // Days level 12 × 11 500 = 138 000; excess 462 000; 11/12 of it left after month 1.
    expect(first ? first.closing.receivables - R(138000) : NaN).toBe(R(423500));
    assertInvariants(inp, out, 'vat');
  });
});

describe('shortfall (opening BELOW the days level) keeps the residual behaviour', () => {
  const { inp, out } = run({ receivables: 100000, payables: -40000, otherEquity: -60000 });
  it('month 1 jumps to the days level: receipts 100 000 + 10 000 − 120 000 = −10 000; AR 120 000 from month 1', () => {
    expect(receipts(out)[0]).toBe(-R(10000));
    expect(out.months.map(m => m.closing.receivables)).toEqual(months.map(() => R(120000)));
  });
  it('payables: payments 40 000 + 5 000 − 60 000 = −15 000 in month 1, AP 60 000 from month 1', () => {
    expect(payments(out)[0]).toBe(R(15000));
    expect(out.months.map(m => -m.closing.payables)).toEqual(months.map(() => R(60000)));
  });
  it('still capped (derived 365), so warned, with no excess', () => {
    expect(out.warnings.filter(w => w.code === 'days_capped')).toEqual([
      { code: 'days_capped', series: 'receivables', days: 365, excess: 0, months: 12 },
      { code: 'days_capped', series: 'payables', days: 365, excess: 0, months: 12 },
    ]);
    assertInvariants(inp, out, 'shortfall');
  });
});

describe('days_capped is present iff the derived days sit at the cap', () => {
  const opening = { receivables: 600000, payables: -300000, otherEquity: -300000 };
  it('derived 200 days: spread applies, no capped warning', () => {
    const { out } = run(opening, a => {
      a.workingCapital.debtorDays = { value: 200, source: 'derived' };
      a.workingCapital.creditorDays = { value: 200, source: 'derived' };
    });
    expect(out.warnings.filter(w => w.code === 'days_capped')).toEqual([]);
    expect(receipts(out)[0]).toBeLessThan(R(100000));
  });
  it('manual 365 days: the user chose it, not capped; the spread still applies', () => {
    const { out } = run(opening, a => {
      a.workingCapital.debtorDays = { value: 365, source: 'manual' };
      a.workingCapital.creditorDays = { value: 365, source: 'manual' };
    });
    expect(out.warnings.filter(w => w.code === 'days_capped')).toEqual([]);
    expect(receipts(out)).toEqual(months.map(() => R(50000)));
  });
  it('only debtor days capped: one warning, receivables', () => {
    const { out } = run(opening, a => {
      a.workingCapital.debtorDays = { value: 365, source: 'derived' };
      a.workingCapital.creditorDays = { value: 30, source: 'derived' };
    });
    expect(out.warnings.filter(w => w.code === 'days_capped').map(w => (w as { series: string }).series)).toEqual(['receivables']);
  });
});
