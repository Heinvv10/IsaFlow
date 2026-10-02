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
  /** null where the ratio could not be stated in that period. */
  value: number | null;
}

export interface RatioTrendResult {
  ratioName: string;
  values: RatioTrendPoint[];
  /** 'not_meaningful' where the first or the last period has no figure. */
  trend: 'improving' | 'declining' | 'stable' | 'not_meaningful';
  /** null with it: a change is measured between two points. */
  changePercent: number | null;
}

// Ratios where higher is better (used for trend classification)
const HIGHER_IS_BETTER = new Set([
  'grossProfitMargin', 'netProfitMargin', 'operatingProfitMargin',
  'currentRatio', 'quickRatio', 'returnOnAssets', 'returnOnEquity',
  'ebitdaMargin', 'roce', 'interestCoverage', 'cashRatio',
  'operatingCashFlowRatio', 'assetTurnover', 'receivablesTurnover',
  'inventoryTurnover', 'freeCashFlow', 'revenuePerEmployee',
  'ebitda', 'workingCapital', 'pbitMargin', 'directMaterialMargin',
  'netOperatingAssetTurnover', 'ebitdaToNetInterest', 'pbtToNetInterest',
  'netProfitToNetInterest', 'pbitPerEmployee', 'ebitdaPerEmployee',
  'dividendCover', 'retentionRate',
]);

// Ratios where lower is better
const LOWER_IS_BETTER = new Set([
  'debtToEquity', 'debtRatio', 'debtorDays', 'creditorDays',
  'inventoryDays', 'cashConversionCycle', 'equityMultiplier',
  'employeeCostToRevenue',
]);

// Key ratios to track (subset — not every ratio needs trend analysis)
const TRACKED_RATIOS: (keyof ExtendedRatioResult)[] = [
  // Core
  'grossProfitMargin', 'netProfitMargin', 'operatingProfitMargin',
  'currentRatio', 'quickRatio', 'debtToEquity',
  'returnOnAssets', 'returnOnEquity',
  'debtorDays', 'creditorDays', 'inventoryTurnover',
  'ebitdaMargin', 'roce', 'interestCoverage',
  'cashRatio', 'assetTurnover', 'cashConversionCycle',
  // AFS Master v15 additions
  'pbitMargin', 'netOperatingAssetTurnover',
  'ebitdaToNetInterest', 'revenuePerEmployee', 'ebitdaPerEmployee',
  'employeeCostToRevenue', 'effectiveTaxRate', 'retentionRate',
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
      value: r[ratioName] as number | null,
    }));

    // Calculate overall change from first to last. A ratio the engine could
    // not state at either end has no change to report: reading its null as 0
    // printed "stable, 0%" for a margin that did not exist.
    const first = values[0]?.value ?? null;
    const last = values[values.length - 1]?.value ?? null;
    if (first === null || last === null) {
      return { ratioName, values, trend: 'not_meaningful' as const, changePercent: null };
    }
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
