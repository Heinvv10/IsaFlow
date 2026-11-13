/**
 * P6 PR C T11: the pure derive core (spec §4 "Derived defaults", decision 10)
 * and I6 through it: derive the days from a daily-flat history, run the engine
 * on the same daily-flat P&L, and AR / AP / inventory stay where they opened.
 */
import { describe, expect, it } from 'vitest';
import { deriveCore, historyWindow, type DeriveInputs } from '@/modules/accounting/services/budgets/threeWay/deriveCore';
import { runThreeWay } from '@/modules/accounting/services/budgets/threeWay/engine';
import { daysInMonth } from '@/modules/accounting/services/budgets/threeWay/months';
import { toLookback, type ActualMonth } from '@/modules/accounting/services/budgets/threeWay/threeWayFolds';
import { emptyPnl } from '@/modules/accounting/services/budgets/threeWay/types';
import { buckets, input, monthsFrom, pnl, R } from './helpers';

function actual(month: string, rands: Partial<Record<'turnover' | 'costOfSales' | 'otherOpex' | 'payroll', number>>, active = true): ActualMonth {
  const p = emptyPnl();
  p.turnover = R(rands.turnover ?? 0);
  p.costOfSales = R(rands.costOfSales ?? 0);
  p.otherOpex = R(rands.otherOpex ?? 0);
  p.payroll = R(rands.payroll ?? 0);
  return { ...p, month, active };
}

const vatOff = { registered: false, cadence: 'bi-monthly' as const, alignment: 'odd' as const, basis: 'invoice' as const, cadenceDefaulted: false };

function base(over: Partial<DeriveInputs> = {}): DeriveInputs {
  const lb = monthsFrom('2025-03', 12);
  return {
    asAt: '2026-02-28', priorYearEnd: '2026-02', entityType: 'pty_ltd', vat: vatOff,
    opening: { receivables: R(45000), payables: -R(24000), inventory: R(12000), holdsInventory: true },
    trailing: lb.map((m) => actual(m, { turnover: 1000 * daysInMonth(m), costOfSales: 600 * daysInMonth(m), otherOpex: 200 * daysInMonth(m) })),
    vatTotals: null, statutory: 0, ...over,
  };
}

describe('deriveCore: days (VAT-inclusive basis)', () => {
  it('a daily-flat year, not VAT registered: 45 / 30 / 20 days, derived, stamped with the as-at', () => {
    const { assumptions: a, evidence } = deriveCore(base());
    expect([a.workingCapital.debtorDays.value, a.workingCapital.creditorDays.value, a.workingCapital.inventoryDays.value]).toEqual([45, 30, 20]);
    expect(a.workingCapital.debtorDays).toMatchObject({ source: 'derived', derivedAsAt: '2026-02-28' });
    expect(evidence.window).toEqual({ first: '2025-03', last: '2026-02', months: 12, days: 365 });
    expect(evidence.insufficientHistory).toBe(false);
  });

  it('VAT registered with shares 1: the flows are VAT-inclusive (45 000 of AR against 1 150 a day is 39.13 days)', () => {
    const vat = { ...vatOff, registered: true };
    const { assumptions: a } = deriveCore(base({ vat, vatTotals: { outputTax: R(1000 * 365 * 0.15), inputTax: R(800 * 365 * 0.15) } }));
    expect(a.vat.vatableSalesShare.value).toBe(1);
    expect(a.vat.vatablePurchasesShare.value).toBe(1);
    expect(a.workingCapital.debtorDays.value).toBe(39.13);
    expect(a.workingCapital.creditorDays.value).toBe(26.09);
  });

  it('fewer than 3 history months: 30 / 30 / 0, insufficient history', () => {
    const t = monthsFrom('2025-03', 12).map((m, i) => actual(m, i >= 10 ? { turnover: 5000 } : {}, i >= 10));
    const { assumptions: a, evidence } = deriveCore(base({ trailing: t }));
    expect([a.workingCapital.debtorDays.value, a.workingCapital.creditorDays.value, a.workingCapital.inventoryDays.value]).toEqual([30, 30, 0]);
    expect(a.workingCapital.debtorDays.basis).toBe('insufficient history');
    expect(evidence).toMatchObject({ insufficientHistory: true, window: { months: 2 } });
  });

  it('the window starts at the first active month (history = 3 months is enough)', () => {
    const t = monthsFrom('2025-03', 12).map((m, i) => actual(m, i >= 9 ? { turnover: 1000 * daysInMonth(m) } : {}, i >= 9));
    expect(historyWindow(t).map((m) => m.month)).toEqual(['2025-12', '2026-01', '2026-02']);
    const { assumptions: a } = deriveCore(base({ trailing: t, opening: { receivables: R(31000), payables: 0, inventory: 0, holdsInventory: false } }));
    expect(a.workingCapital.debtorDays.value).toBe(31);
    expect(a.workingCapital.inventoryDays).toMatchObject({ value: 0, basis: 'no inventory account held' });
  });

  it('days are clamped to the schema bounds and a nil balance is 0 days', () => {
    const { assumptions: a } = deriveCore(base({ opening: { receivables: R(5_000_000), payables: R(10), inventory: R(9_000_000), holdsInventory: true } }));
    expect(a.workingCapital.debtorDays.value).toBe(365);
    expect(a.workingCapital.creditorDays.value).toBe(0);
    expect(a.workingCapital.inventoryDays.value).toBe(730);
  });
});

describe('deriveCore: VAT shares, statutory share, company VAT settings', () => {
  it('shares are output (input) VAT ÷ (base × 15 %), clamped to 0..1', () => {
    const vat = { ...vatOff, registered: true };
    const half = deriveCore(base({ vat, vatTotals: { outputTax: R(1000 * 365 * 0.075), inputTax: R(800 * 365 * 0.3) } })).assumptions.vat;
    expect(half.vatableSalesShare.value).toBe(0.5);
    expect(half.vatablePurchasesShare.value).toBe(1);
  });

  it('not registered: shares stay at the defaults and no VAT figures are read into the evidence', () => {
    const d = deriveCore(base({ vatTotals: { outputTax: R(1), inputTax: R(1) } }));
    expect(d.assumptions.vat.registered.value).toBe(false);
    expect(d.assumptions.vat.vatableSalesShare.value).toBe(1);
    expect(d.evidence.vat).toBeNull();
  });

  it('statutory share = EMP201 (PAYE + UIF + SDL) ÷ payroll expense of the last 3 months', () => {
    const t = monthsFrom('2025-03', 12).map((m) => actual(m, { turnover: 1000, payroll: 100000 }));
    expect(deriveCore(base({ trailing: t, statutory: R(90000) })).assumptions.payroll.statutoryShare.value).toBe(0.3);
    expect(deriveCore(base({ statutory: R(90000) })).assumptions.payroll.statutoryShare).toMatchObject({ value: 0 });
  });

  it('a NULL vat_period (registered) is bi-monthly, marked defaulted (§13.11)', () => {
    const vat = { ...vatOff, registered: true, cadenceDefaulted: true };
    expect(deriveCore(base({ vat })).assumptions.vat.cadence).toMatchObject({ value: 'bi-monthly', basis: 'defaulted — not configured' });
  });

  it('income tax follows the entity type (§13.2) and the top-up offset the prior year end', () => {
    expect(deriveCore(base()).assumptions.incomeTax.mode.value).toBe('provisional');
    expect(deriveCore(base({ entityType: 'trust' })).assumptions.incomeTax.mode.value).toBe('off');
    expect(deriveCore(base()).assumptions.incomeTax.topUpMonthOffset.value).toBe(7);
    expect(deriveCore(base({ priorYearEnd: '2026-06' })).assumptions.incomeTax.topUpMonthOffset.value).toBe(6);
  });
});

describe('I6 through the derive: derive-then-flat keeps AR, AP and inventory constant', () => {
  it('daily-flat history and plan: every closing equals its opening', () => {
    const d = base();
    const { assumptions: a } = deriveCore(d);
    const months = monthsFrom('2026-03', 12);
    const out = runThreeWay(input({
      months,
      pnl: months.map((m) => pnl({ turnover: 1000 * daysInMonth(m), costOfSales: 600 * daysInMonth(m), otherOpex: 200 * daysInMonth(m) })),
      lookback: toLookback(d.trailing),
      opening: buckets({ cash: 100000, receivables: 45000, inventory: 12000, payables: -24000, otherEquity: -133000 }),
      assumptions: a,
    }));
    for (const m of out.months) {
      expect([m.month, m.closing.receivables, m.closing.payables, m.closing.inventory]).toEqual([m.month, R(45000), -R(24000), R(12000)]);
    }
  });
});
