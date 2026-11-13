import { describe, it, expect } from 'vitest';
import { runThreeWay } from '@/modules/accounting/services/budgets/threeWay/engine';
import { MAX_VALUE_CENTS } from '@/modules/accounting/services/budgets/threeWay/ratios';
import { addMonths } from '@/modules/accounting/services/budgets/threeWay/months';
import { assumptions, buckets, input, monthsFrom, pnl, R, lookbackMonths } from '../helpers';
import { assertInvariants } from '../invariants';
import { emptyBuckets, emptyPnl } from '@/modules/accounting/services/budgets/threeWay/types';

describe('round 2', () => {
  it('R2-1 a full-life previewSchedule (60 lines, loan started before the version) for an included existing loan', () => {
    const months = monthsFrom('2026-03', 12);
    const a = assumptions(months, {}, d => { d.loans.existing = [{ loanId: 'E1', include: true }]; });
    const lines = Array.from({ length: 60 }, (_, i) => ({ month: addMonths('2025-01', i), principal: R(1000), interest: R(100) }));
    const inp = input({ months, pnl: months.map(() => pnl({ financeCost: 100 })), opening: buckets({ cash: 100000, loans: -46000, shareCapital: -54000 }), assumptions: a,
      loanSchedules: [{ loanId: 'E1', lines }] });
    // Hand: only the 12 in-version lines apply → cash 100 000 − 12 × (1 000 + 100) = 86 800; loans −34 000.
    const out = runThreeWay(inp);
    expect([out.months[11]!.closing.cash, out.months[11]!.closing.loans]).toEqual([R(86800), R(-34000)]);
  });

  it('R2-2 debit opening payroll liability carried flat; accruals remitted in full m+1', () => {
    const months = monthsFrom('2026-03', 3);
    const inp = input({ months, pnl: [pnl({ payroll: 100000 }), pnl({ payroll: 100000 }), pnl({})], opening: buckets({ cash: 300000, payrollLiabilities: 5000, shareCapital: -305000 }),
      assumptions: assumptions(months, { statutoryShare: 0.3 }) });
    const out = runThreeWay(inp);
    assertInvariants(inp, out);
    // M1 −70 000; M2 −30 000 −70 000; M3 −30 000. Liab: −25 000, −25 000, +5 000.
    expect(out.months.map(m => [m.closing.cash, m.closing.payrollLiabilities])).toEqual([[R(230000), R(-25000)], [R(130000), R(-25000)], [R(100000), R(5000)]]);
    expect(out.warnings.some(w => w.code === 'opening_debit_carried')).toBe(true);
  });

  it('R2-3 bounds: maximal legal input either balances exactly or throws RANGE', () => {
    const months = monthsFrom('2026-03', 15);
    // spend ~1e15 total budget on the most amplifying shape: inventory days 730 + creditor days 365 + 36 lookback
    const v = 9_700_000_000_000; void MAX_VALUE_CENTS;
    const lb = Array.from({ length: 36 }, (_, i) => ({ month: addMonths('2026-03', i - 36), turnover: 0, costOfSales: v, supplierPurchases: v }));
    const p = months.map(() => { const x = emptyPnl(); x.costOfSales = v; x.turnover = v; return x; });
    const opening = emptyBuckets(); opening.cash = 1; opening.retainedEarnings = -1;
    const inp = input({ months, pnl: p, lookback: lb, opening, assumptions: assumptions(months, { vat: { cadence: 'monthly', basis: 'payment' }, debtorDays: 365, creditorDays: 365, inventoryDays: 730 }) });
    let out;
    try { out = runThreeWay(inp); } catch (e) { throw new Error('THREW ' + (e as Error).message); }
    assertInvariants(inp, out);
  });

  it('R2-4 negative payroll month after a credit opening: no cash refund of a debit that arose in-version? (documented behaviour probe)', () => {
    const months = monthsFrom('2026-03', 3);
    const inp = input({ months, pnl: [pnl({ payroll: -10000 }), pnl({}), pnl({})], opening: buckets({ cash: 100000, shareCapital: -100000 }), assumptions: assumptions(months, { statutoryShare: 0.3 }) });
    const out = runThreeWay(inp);
    assertInvariants(inp, out);
    expect(out.months.map(m => m.closing.cash)).toEqual([R(110000) - R(3000), R(110000), R(110000)]);
  });

  it('R2-5 property re-run with debit statutory openings and dividends straddling the start', () => {
    for (let s = 1; s <= 200; s++) {
      const n = 1 + (s % 15);
      const months = monthsFrom(`20${26 + (s % 4)}-${String(1 + (s % 12)).padStart(2, '0')}`, n);
      const a = assumptions(months, { vat: { cadence: s % 2 ? 'monthly' : 'bi-monthly', alignment: s % 3 ? 'odd' : 'even', basis: s % 5 ? 'invoice' : 'payment' }, debtorDays: (s * 7) % 366, creditorDays: (s * 11) % 366, inventoryDays: (s * 13) % 731, statutoryShare: 0.27 }, d => {
        d.equity.dividends = [{ id: 'a', declaredMonth: addMonths(months[0]!, -1), paidMonth: months[0]!, amount: 777 }, { id: 'b', declaredMonth: months[0]!, paidMonth: addMonths(months[0]!, n), amount: 999 }];
        d.loans.planned = [{ id: 'p', description: '', drawdownMonth: addMonths(months[0]!, -2), principal: 5000, annualRatePct: 1, termMonths: 5, firstRepaymentMonth: months[0]! }];
        d.capex = [{ id: 'c', month: months[n - 1]!, amountExVat: 12345, vatClaimable: true, description: '' }];
        d.incomeTax.topUpMonthOffset = { value: s % 2 ? 6 : 7, source: s % 3 ? 'derived' : 'manual' };
      });
      const inp = input({ months, pnl: months.map((_, i) => ({ ...emptyPnl(), turnover: 100003 * (i + s), costOfSales: 50001 * i, otherOpex: 30007, payroll: 40009, taxExpense: 1001, depreciation: 97, financeCost: 13 })),
        lookback: lookbackMonths(addMonths(months[0]!, -3), [{ turnover: 1 }, { costOfSales: 5 }, { supplierPurchases: 9 }]),
        opening: buckets({ cash: 1000, payrollLiabilities: 3, incomeTaxPayable: 7, inventory: 11, vatControl: -13, retainedEarnings: -1008 }), assumptions: a,
        loanSchedules: [{ loanId: 'p', lines: months.map(m => ({ month: m, principal: 100, interest: 13 })) }] });
      const out = runThreeWay(inp);
      assertInvariants(inp, out, `seed ${s}`);
      expect(out.months[n - 1]!.closing.loans, `seed ${s} loans`).toBe(0);
      expect(out.months[n - 1]!.closing.dividendsPayable, `seed ${s} div`).toBe(-999);
    }
  });
});

describe('round 2 review LOWs', () => {
  it('a full-life schedule whose out-of-version lines are huge does not trip the total bound', () => {
    const months = monthsFrom('2026-03', 3);
    const a = assumptions(months, {}, d => { d.loans.existing = [{ loanId: 'E1', include: true }]; });
    // 200 pre-version lines at the per-value cap: 2e15 cents outside the version, none inside.
    const lines = Array.from({ length: 200 }, (_, i) => ({ month: addMonths('2009-01', i), principal: MAX_VALUE_CENTS, interest: 0 }));
    const out = runThreeWay(input({ months, pnl: months.map(() => pnl({})), opening: buckets({ cash: 1000, shareCapital: -1000 }), assumptions: a,
      loanSchedules: [{ loanId: 'E1', lines }] }));
    expect(out.months[2]!.closing.cash).toBe(R(1000));
  });
});
