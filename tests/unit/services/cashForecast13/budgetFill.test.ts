import { describe, it, expect } from 'vitest';
import { runEngine } from '@/modules/accounting/services/cashForecast13/engine';
import type { EngineInput, KnownItem } from '@/modules/accounting/services/cashForecast13/types';

const NO_OVERDUE = { totalCents: 0, beyondHorizonCents: 0, invoiceCount: 0, byBasis: { history: 0, no_history: 0 }, disputedCents: 0 };
const base = (over: Partial<EngineInput>): EngineInput => ({
  today: '2026-12-01', openingCents: 0, items: [], budget: null, manualItems: [], overrides: [], overdueAR: NO_OVERDUE, warnings: [], ...over,
});
const ar = (date: string, amountCents: number): KnownItem => ({
  lineKey: 'ar:c:due', lineLabel: 'C', category: 'customer_receipts', date, amountCents, ref: `r${date}${amountCents}`, refLabel: 'r',
});
const ap = (date: string, amountCents: number): KnownItem => ({
  lineKey: 'ap:s', lineLabel: 'S', category: 'supplier_payments', date, amountCents, ref: `p${date}`, refLabel: 'p',
});
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('cash13 budget fill', () => {
  // today 2026-12-01 (Tue): week 1 = 2026-11-30..12-06; December's 31 days are all from today on.
  it('fills budget minus known for the month, spread evenly by day, marked estimate', () => {
    const out = runEngine(base({
      items: [ar('2026-12-10', 1_000)],
      budget: [{ month: '2026-12', customerReceipts: 3_100, supplierPayments: 0 }],
    }));
    const line = out.lines.find((l) => l.key === 'budget:customer_receipts')!;
    expect(line.kind).toBe('estimate');
    expect(line.category).toBe('customer_receipts');
    // 2,100 over 31 days; today is the 1st so all 31 days are in the horizon.
    expect(sum(line.weekly)).toBe(2_100);
    // week 1 holds Dec 1..6 = 6 days of 2100/31 (cumulative rounding).
    expect(line.weekly[0]).toBe(Math.round((2_100 * 6) / 31));
  });

  it('floors at zero when known items exceed the budget', () => {
    const out = runEngine(base({
      items: [ar('2026-12-10', 5_000)],
      budget: [{ month: '2026-12', customerReceipts: 3_100, supplierPayments: 0 }],
    }));
    expect(out.lines.find((l) => l.key === 'budget:customer_receipts')).toBeUndefined();
  });

  it('works signed for payments: budget −3100 less known −1000 leaves −2100', () => {
    const out = runEngine(base({
      items: [ap('2026-12-10', -1_000)],
      budget: [{ month: '2026-12', customerReceipts: 0, supplierPayments: -3_100 }],
    }));
    const line = out.lines.find((l) => l.key === 'budget:supplier_payments')!;
    expect(sum(line.weekly)).toBe(-2_100);
  });

  it('counts an overdue known item in the month it lands in (today), not its own month', () => {
    const out = runEngine(base({
      items: [ar('2026-10-15', 1_000)],
      budget: [{ month: '2026-12', customerReceipts: 3_100, supplierPayments: 0 }],
    }));
    expect(sum(out.lines.find((l) => l.key === 'budget:customer_receipts')!.weekly)).toBe(2_100);
  });

  it('counts only the days from today on in the current month, and only horizon days in the last', () => {
    // today 2026-11-16 (Mon): November has 30 days, 15 of them (16..30) from today; horizon ends 2027-02-14.
    const out = runEngine(base({
      today: '2026-11-16',
      budget: [
        { month: '2026-11', customerReceipts: 3_000, supplierPayments: 0 },
        { month: '2027-02', customerReceipts: 2_800, supplierPayments: 0 },
        { month: '2027-03', customerReceipts: 9_999, supplierPayments: 0 },
      ],
    }));
    const line = out.lines.find((l) => l.key === 'budget:customer_receipts')!;
    // Nov: 3000 × 15/30 = 1500; Feb: 2800 × 14/28 = 1400; March is outside the horizon.
    expect(sum(line.weekly)).toBe(1_500 + 1_400);
  });

  it('prorates the budget to the in-horizon days FIRST, then subtracts known (current month: R1m × 15/30 − R500k = 0)', () => {
    // Reviewer probe: subtracting before prorating left R250k of phantom receipts.
    const out = runEngine(base({
      today: '2026-11-16',
      items: [ar('2026-11-20', 500_000_00)],
      budget: [{ month: '2026-11', customerReceipts: 1_000_000_00, supplierPayments: 0 }],
    }));
    expect(out.lines.find((l) => l.key === 'budget:customer_receipts')).toBeUndefined();
  });

  it('the last partial month the same way (Feb: R1m × 14/28 − R500k = 0), and a remainder is spread over in-horizon days only', () => {
    const feb = runEngine(base({
      today: '2026-11-16',
      items: [ar('2027-02-10', 500_000_00)],
      budget: [{ month: '2027-02', customerReceipts: 1_000_000_00, supplierPayments: 0 }],
    }));
    expect(feb.lines.find((l) => l.key === 'budget:customer_receipts')).toBeUndefined();
    const part = runEngine(base({
      today: '2026-11-16',
      items: [ar('2026-11-20', 1_000)],
      budget: [{ month: '2026-11', customerReceipts: 3_000, supplierPayments: 0 }],
    }));
    const line = part.lines.find((l) => l.key === 'budget:customer_receipts')!;
    // 3000 × 15/30 = 1500, less 1000 known = 500, over Nov 16..30 (weeks 1-3; Nov 30 is a Monday).
    expect(sum(line.weekly)).toBe(500);
    expect(line.weekly.slice(3).every((v) => v === 0)).toBe(true);
  });

  it('subtracts the GROSS known (before credit netting), so netted-off credit is not refilled (re-review N1)', () => {
    // Nov in-horizon budget R500k (R1m × 15/30), AR R500k, R40k unapplied receipt → AR R460k, fill R0.
    const gross = ar('2026-11-20', 500_000_00);
    const out = runEngine(base({
      today: '2026-11-16',
      items: [{ ...gross, amountCents: 460_000_00 }],
      budgetKnown: [gross],
      budget: [{ month: '2026-11', customerReceipts: 1_000_000_00, supplierPayments: 0 }],
    }));
    expect(sum(out.lines.find((l) => l.key === 'ar:c:due')!.weekly)).toBe(460_000_00);
    expect(out.lines.find((l) => l.key === 'budget:customer_receipts')).toBeUndefined();
  });

  it('the AP mirror: a supplier credit netted off a bill is not refilled by the budgeted payments', () => {
    const gross = ap('2026-11-20', -500_000_00);
    const out = runEngine(base({
      today: '2026-11-16',
      items: [{ ...gross, amountCents: -460_000_00 }],
      budgetKnown: [gross],
      budget: [{ month: '2026-11', customerReceipts: 0, supplierPayments: -1_000_000_00 }],
    }));
    expect(out.lines.find((l) => l.key === 'budget:supplier_payments')).toBeUndefined();
  });

  it('ignores receipts that are not customer receipts when subtracting known', () => {
    const loan: KnownItem = { ...ar('2026-12-10', 1_000), lineKey: 'loan:x', category: 'loans' };
    const out = runEngine(base({ items: [loan], budget: [{ month: '2026-12', customerReceipts: 3_100, supplierPayments: 0 }] }));
    expect(sum(out.lines.find((l) => l.key === 'budget:customer_receipts')!.weekly)).toBe(3_100);
  });

  it('adds no budget lines when budget is null', () => {
    const out = runEngine(base({ items: [ar('2026-12-10', 1)] }));
    expect(out.lines.some((l) => l.kind === 'estimate')).toBe(false);
  });
});
