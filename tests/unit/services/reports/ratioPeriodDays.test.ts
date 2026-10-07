/**
 * A DAY COUNT IS MEASURED ON THE DAYS THE FLOW FIGURE COVERS.
 *
 * Debtor days is receivables over revenue times the days that revenue was
 * earned in. The engine multiplied by 365 whatever the window, so a six-month
 * pack read six months' revenue as a year's: a company with 50 real debtor
 * days printed 99, and the board pack scored it MISSED against a 30-day
 * target. Creditor days, inventory days and the cash conversion cycle carried
 * the same multiplier.
 *
 * Every producer that builds the engine's input from a reporting window now
 * says how many days the window holds (`FinancialData.periodDays`, required:
 * a caller holding a year's figures passes 365 itself).
 */
import { describe, expect, it } from 'vitest';
import { calculateExtendedRatios, type FinancialData } from '@/modules/accounting/services/reports/reportingEngineService';
import { notPositive, PERIOD_LENGTH_NOT_MEASURED } from '@/modules/accounting/services/reports/ratioBasis';
import { inclusiveDays } from '@/modules/accounting/services/reports/priorPeriod';
import { buildReportPack } from '@/modules/accounting/services/reports/reportPackService';
import { readCreditorDays, readDebtorDays } from '@/modules/accounting/services/packs/figures/packMetricReads';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { buildScorecardGroups, packFiguresToFinancialData } from '@/modules/accounting/services/packs/pages/packScorecard';
import { demoSet, figures } from '../packs/fixtures/boardPackInputs';

/** Six months: 1 March to 31 August 2026 is 184 days. */
const SIX_MONTHS: FinancialData = {
  revenue: 3_680_000, costOfSales: 2_000_000, operatingExpenses: 900_000, netProfit: 780_000,
  totalAssets: 5_000_000, totalLiabilities: 2_000_000, totalEquity: 3_000_000,
  currentAssets: 2_500_000, currentLiabilities: 1_200_000,
  accountsReceivable: 1_000_000, accountsPayable: 400_000, inventory: 250_000, cash: 300_000,
  periodDays: 184,
};

describe('the engine\'s day counts', () => {
  it('multiply by the days in the window the revenue and cost of sales cover', () => {
    const r = calculateExtendedRatios(SIX_MONTHS);
    // 1 000 000 / 3 680 000 × 184 — not × 365, which is 99.18.
    expect(r.debtorDays).toBe(50);
    // 400 000 / 2 000 000 × 184.
    expect(r.creditorDays).toBe(36.8);
    // Turnover 2 000 000 / 250 000 = 8; 184 / 8.
    expect(r.inventoryDays).toBe(23);
    expect(r.cashConversionCycle).toBe(36.2);
  });

  it('take 365 where the caller says its figures are a year\'s', () => {
    const r = calculateExtendedRatios({ ...SIX_MONTHS, periodDays: 365 });
    expect(r.debtorDays).toBe(99.18);
    expect(r.creditorDays).toBe(73);
    expect(r.inventoryDays).toBe(45.63);
    expect(r.cashConversionCycle).toBe(71.81);
  });

  it('count a leap year as the 366 days it is', () => {
    expect(calculateExtendedRatios({ ...SIX_MONTHS, periodDays: 366 }).debtorDays).toBe(99.46);
  });

  it('state none, and say why, where the window could not be measured', () => {
    for (const periodDays of [null, 0]) {
      const r = calculateExtendedRatios({ ...SIX_MONTHS, periodDays });
      expect(r.debtorDays).toBeNull();
      expect(r.creditorDays).toBeNull();
      expect(r.inventoryDays).toBeNull();
      expect(r.cashConversionCycle).toBeNull();
      expect(r.notMeaningful.debtorDays).toBe(PERIOD_LENGTH_NOT_MEASURED);
      expect(r.notMeaningful.creditorDays).toBe(PERIOD_LENGTH_NOT_MEASURED);
      expect(r.notMeaningful.inventoryDays).toBe(PERIOD_LENGTH_NOT_MEASURED);
    }
  });

  it('state nil inventory days where no stock is held, measurable window or not', () => {
    for (const periodDays of [184, null]) {
      const r = calculateExtendedRatios({ ...SIX_MONTHS, inventory: 0, periodDays });
      expect(r.inventoryDays).toBe(0);
      expect(r.notMeaningful.inventoryDays).toBeUndefined();
    }
  });

  it('keep the revenue reason first where the base is not positive either', () => {
    const r = calculateExtendedRatios({ ...SIX_MONTHS, revenue: 0, periodDays: null });
    expect(r.notMeaningful.debtorDays).toBe(notPositive('Revenue'));
  });
});

/**
 * INVENTORY DAYS ON THE UNROUNDED QUOTIENT. It was the window's days over a
 * turnover already rounded to two places, which is a different number.
 */
describe('inventory days', () => {
  const stock = (inventory: number, costOfSales: number, periodDays: number) =>
    calculateExtendedRatios({ ...SIX_MONTHS, inventory, costOfSales, periodDays }).inventoryDays;

  it('are inventory over cost of sales times the days, not the days over a rounded turnover', () => {
    // A month: 3 000 000 / 100 000 × 31. Over a turnover of 0.03 it was 1 033.33.
    expect(stock(3_000_000, 100_000, 31)).toBe(930);
    // 184 days: 300 000 / 70 000 × 184. Over a turnover of 0.23 it was 800.
    expect(stock(300_000, 70_000, 184)).toBe(788.57);
    // A turnover that rounded to 0.00 printed nil days.
    expect(stock(25_000_000, 100_000, 31)).toBe(7750);
  });

  it('carry into the cash conversion cycle', () => {
    const r = calculateExtendedRatios({ ...SIX_MONTHS, inventory: 300_000, costOfSales: 70_000, periodDays: 184 });
    expect(r.cashConversionCycle).toBe(
      Math.round(((r.debtorDays ?? 0) + 788.57 - (r.creditorDays ?? 0)) * 100) / 100);
  });
});

describe('inclusiveDays', () => {
  it('counts both ends of the window', () => {
    expect(inclusiveDays('2026-03-01', '2026-08-31')).toBe(184);
    expect(inclusiveDays('2026-01-01', '2026-09-07')).toBe(250);
    expect(inclusiveDays('2024-01-01', '2024-12-31')).toBe(366);
    expect(inclusiveDays('2026-08-01', '2026-08-01')).toBe(1);
  });

  it('is null on a date it cannot read, never NaN', () => {
    expect(inclusiveDays('xx', '2026-08-31')).toBeNull();
  });
});

describe('the callers that build the engine\'s input from a window', () => {
  it('the management pack passes its input\'s day count on', () => {
    const input = { ...figures({ revenue: 3_680_000, accountsReceivable: 1_000_000 }), periodDays: 184 };
    const pack = buildReportPack('management', input, '2026-03-01', '2026-08-31');
    const ratios = pack.sections.find((s) => s.type === 'ratios')!.data as { debtorDays: number };
    expect(ratios.debtorDays).toBe(50);
  });

  it('the board pack passes its figures\' day count on', () => {
    expect(packFiguresToFinancialData(figures({ periodDays: 184 })).periodDays).toBe(184);
  });

  it('the board scorecard scores the window\'s own debtor days', () => {
    // 360 000 / 3 680 000 × 184 = 18 days, inside the 30-day target. Read on
    // 365 the same book is 35.71 days and MISSED.
    const current = figures({ revenue: 3_680_000, accountsReceivable: 360_000, periodDays: 184 });
    const row = buildScorecardGroups({ ...demoSet, current }, new PackFigureProvenance())
      .flatMap((g) => g.rows).find((r) => r.metric === 'Debtor days')!;
    expect(row.actual.value).toBe(18);
    expect(row.status).toBe('met');
  });

  it('the pack\'s unrounded reads use the window too', () => {
    // The engine rounds 1 / 10 000 000 × 184 to 0.00, and the read restates it.
    const raw = figures({
      revenue: 10_000_000, accountsReceivable: 1, costOfSales: 10_000_000, accountsPayable: 1, periodDays: 184,
    });
    const ratios = calculateExtendedRatios(packFiguresToFinancialData(raw));
    expect(ratios.debtorDays).toBe(0);
    expect(readDebtorDays(ratios, raw).value).toBeCloseTo(1.84e-5, 10);
    expect(readCreditorDays(ratios, raw).value).toBeCloseTo(1.84e-5, 10);
  });
});
