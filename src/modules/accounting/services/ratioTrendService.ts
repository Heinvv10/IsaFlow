/**
 * Ratio Trend Service — multi-period ratio tracking with trend classification.
 * Pure business logic — no database dependencies.
 */

import {
  calculateExtendedRatios,
  type FinancialData,
  type ExtendedRatioResult,
} from './reportingEngineService';

export interface RatioTrendPoint {
  period: string;
  value: number;
}

export interface RatioTrendResult {
  ratioName: string;
  values: RatioTrendPoint[];
  trend: 'improving' | 'declining' | 'stable';
  changePercent: number;
}

// Ratios where higher is better (used for trend classification)
const HIGHER_IS_BETTER = new Set([
  'grossProfitMargin', 'netProfitMargin', 'operatingProfitMargin',
  'currentRatio', 'quickRatio', 'returnOnAssets', 'returnOnEquity',
  'ebitdaMargin', 'roce', 'interestCoverage', 'cashRatio',
  'operatingCashFlowRatio', 'assetTurnover', 'receivablesTurnover',
  'inventoryTurnover', 'freeCashFlow', 'revenuePerEmployee',
  'ebitda', 'workingCapital',
]);

// Ratios where lower is better
const LOWER_IS_BETTER = new Set([
  'debtToEquity', 'debtRatio', 'debtorDays', 'creditorDays',
  'inventoryDays', 'cashConversionCycle', 'equityMultiplier',
]);

// Key ratios to track (subset — not every ratio needs trend analysis)
const TRACKED_RATIOS: (keyof ExtendedRatioResult)[] = [
  'grossProfitMargin', 'netProfitMargin', 'operatingProfitMargin',
  'currentRatio', 'quickRatio', 'debtToEquity',
  'returnOnAssets', 'returnOnEquity',
  'debtorDays', 'creditorDays', 'inventoryTurnover',
  'ebitdaMargin', 'roce', 'interestCoverage',
  'cashRatio', 'assetTurnover', 'cashConversionCycle',
];

/**
 * Calculate ratio trends across multiple periods.
 */
export function calculateRatioTrends(
  periodsData: FinancialData[],
  periodLabels: string[],
): RatioTrendResult[] {
  if (periodsData.length === 0) return [];

  // Calculate ratios for each period
  const allRatios = periodsData.map(d => calculateExtendedRatios(d));

  return TRACKED_RATIOS.map(ratioName => {
    const values: RatioTrendPoint[] = allRatios.map((r, i) => ({
      period: periodLabels[i] || `Period ${i + 1}`,
      value: r[ratioName] as number,
    }));

    // Calculate overall change from first to last
    const first = values[0]?.value ?? 0;
    const last = values[values.length - 1]?.value ?? 0;
    const changePercent = first !== 0
      ? Math.round(((last - first) / Math.abs(first)) * 10000) / 100
      : 0;

    // Classify trend
    const trend = classifyTrend(ratioName, changePercent);

    return { ratioName, values, trend, changePercent };
  });
}

function classifyTrend(
  ratioName: string,
  changePercent: number,
): 'improving' | 'declining' | 'stable' {
  const threshold = 2; // ±2% is considered stable

  if (Math.abs(changePercent) < threshold) return 'stable';

  if (HIGHER_IS_BETTER.has(ratioName)) {
    return changePercent > 0 ? 'improving' : 'declining';
  }

  if (LOWER_IS_BETTER.has(ratioName)) {
    return changePercent < 0 ? 'improving' : 'declining';
  }

  // Default: higher is better
  return changePercent > 0 ? 'improving' : 'declining';
}
