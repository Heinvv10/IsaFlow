/**
 * EVERY RATIO PRINTS IN ITS UNIT, AND EVERY MULTIPLE CARRIES ×.
 *
 * The management pack printed "Receivables Turnover 1.71×" and "Payables
 * Turnover 0.46×" two rows from "Current Ratio (0.14)", "Debt Ratio 1.68" and
 * "Cash Ratio (0.16)" — five multiples, two notations — and the KPI tile read
 * "(0.14) / 1.50". "Revenue per Employee 10 140.00" carried no currency, so a
 * rand amount per head read like a count.
 *
 * The decision, for every surface that goes through `ratioPresentation`:
 *  - a MULTIPLE ("x times": covers, turnovers, the liquidity and gearing
 *    ratios) prints with ×, two decimals, negatives bracketed: "(0.14)×";
 *  - a level (margin, return, rate) is a percentage: "45.0%";
 *  - a day count: "213 days";
 *  - a PER-HEAD amount is money WITH the symbol: "R 10 140.00";
 *  - a statement amount (EBITDA, working capital, free cash flow) is money
 *    without it, as the pack's statement tables print money.
 * A target is written in the same unit as its value.
 */
import { describe, expect, it } from 'vitest';
import { formatRatioOf, RATIO_FORMATS } from '@/modules/accounting/services/reports/ratioPresentation';
import { scorecardFigure, formatScorecardValue } from '@/modules/accounting/services/packs/packKvFormat';
import type { KPIScorecardItem } from '@/modules/accounting/services/reports/kpiScorecardService';

const plain = (s: string): string => s.replace(/[  ]/g, ' ');

const UNIT_OF: Record<string, 'times' | 'pct' | 'days' | 'currency' | 'money'> = {
  grossProfitMargin: 'pct', netProfitMargin: 'pct', operatingProfitMargin: 'pct',
  currentRatio: 'times', quickRatio: 'times', debtToEquity: 'times',
  returnOnAssets: 'pct', returnOnEquity: 'pct', debtorDays: 'days', creditorDays: 'days',
  inventoryTurnover: 'times', ebitda: 'money', ebitdaMargin: 'pct', roce: 'pct', pbitMargin: 'pct',
  directMaterialMargin: 'pct', interestCoverage: 'times', debtRatio: 'times', equityMultiplier: 'times',
  cashRatio: 'times', workingCapital: 'money', operatingCashFlowRatio: 'times',
  assetTurnover: 'times', receivablesTurnover: 'times', payablesTurnover: 'times',
  inventoryDays: 'days', cashConversionCycle: 'days', netOperatingAssetTurnover: 'times',
  freeCashFlow: 'money', ebitdaToNetInterest: 'times', pbtToNetInterest: 'times', netProfitToNetInterest: 'times',
  revenuePerEmployee: 'currency', pbitPerEmployee: 'currency', ebitdaPerEmployee: 'currency',
  employeeCostToRevenue: 'pct', employeeCostPerHead: 'currency',
  dividendCover: 'times', retentionRate: 'pct', effectiveTaxRate: 'pct',
  dupontMargin: 'pct', dupontTurnover: 'times', dupontLeverage: 'times',
};

/** What 10 140.5 and −0.14 print as, in each unit. */
const WRITTEN: Record<string, [string, string]> = {
  times: ['10 140.50×', '(0.14)×'],
  pct: ['10 140.5%', '(0.1%)'],
  days: ['10 141 days', '0 days'],
  currency: ['R 10 140.50', '(R 0.14)'],
  money: ['10 140.50', '(0.14)'],
};

describe('the unit table', () => {
  it('has a unit for every ratio, and no other', () => {
    expect(Object.keys(RATIO_FORMATS).sort()).toEqual(Object.keys(UNIT_OF).sort());
  });

  it.each(Object.entries(UNIT_OF))('%s prints as a %s', (key, unit) => {
    expect(plain(formatRatioOf(key, 10_140.5))).toBe(WRITTEN[unit]![0]);
    expect(plain(formatRatioOf(key, -0.14))).toBe(WRITTEN[unit]![1]);
  });
});

const item = (ratioKey: string, value: number | null, target: number): KPIScorecardItem => ({
  ratioKey, name: ratioKey, value, target, status: value === null ? 'not_meaningful' : 'red', percentOfTarget: 0,
  ...(value === null ? { reason: 'Equity is negative.' } : {}),
});

describe('a KPI tile writes value and target in one unit', () => {
  it.each([
    ['currentRatio', -0.14, 1.5, '(0.14)× / 1.50×'],
    ['debtToEquity', 0.62, 0.5, '0.62× / 0.50×'],
    ['interestCoverage', 5.17, 3, '5.17× / 3.00×'],
    ['cashRatio', 0.16, 0.3, '0.16× / 0.30×'],
    ['grossProfitMargin', -1310.83, 35, '(1 310.8%) / 35.0%'],
    ['debtorDays', 213.23, 30, '213 days / 30 days'],
  ])('%s', (key, value, target, written) => {
    expect(plain(formatScorecardValue(item(key, value, target)))).toBe(written);
  });

  it('writes the target in its unit where the value is not stated', () => {
    expect(scorecardFigure(item('debtToEquity', null, 0.5))).toEqual({ scored: false, reason: 'Equity is negative.', target: '0.50×' });
  });
});
