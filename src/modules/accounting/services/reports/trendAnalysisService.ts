/**
 * Trend Analysis Service — growth rates, moving averages, anomaly detection.
 * Pure business logic — no database dependencies.
 */

export interface TrendDataPoint {
  period: string;
  value: number;
}

export interface TrendAnalysis {
  dataPoints: TrendDataPoint[];
  movingAverage3: (number | null)[];
  growthRates: number[];
  cmgr: number; // Compound Monthly Growth Rate
  anomalies: number[]; // Indices of anomalous data points
}

/**
 * Analyze a time series of data points.
 */
export function analyzeTrend(dataPoints: TrendDataPoint[]): TrendAnalysis {
  if (dataPoints.length === 0) {
    return { dataPoints: [], movingAverage3: [], growthRates: [], cmgr: 0, anomalies: [] };
  }

  const values = dataPoints.map(d => d.value);

  const growthRates = computeGrowthRates(values);
  const movingAverage3 = calculateMovingAverage(values, 3);
  const cmgr = computeCMGR(values);
  const anomalies = detectAnomalies(values, 2);

  return { dataPoints, movingAverage3, growthRates, cmgr, anomalies };
}

/**
 * Calculate moving average for a window size.
 */
export function calculateMovingAverage(values: number[], window: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < window - 1) return null;
    const slice = values.slice(i - window + 1, i + 1);
    return Math.round((slice.reduce((a, b) => a + b, 0) / window) * 100) / 100;
  });
}

/**
 * Detect anomalies — values more than `stdDevMultiplier` standard deviations from mean.
 * Returns array of indices.
 */
export function detectAnomalies(values: number[], stdDevMultiplier: number): number[] {
  if (values.length < 3) return [];

  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  const stdDev = Math.sqrt(variance);

  if (stdDev === 0) return [];

  const threshold = stdDevMultiplier * stdDev;
  const anomalies: number[] = [];

  for (let i = 0; i < values.length; i++) {
    if (Math.abs(values[i]! - mean) > threshold) {
      anomalies.push(i);
    }
  }

  return anomalies;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computeGrowthRates(values: number[]): number[] {
  const rates: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1]!;
    const curr = values[i]!;
    if (prev === 0) {
      rates.push(0);
    } else {
      rates.push(Math.round(((curr - prev) / Math.abs(prev)) * 10000) / 100);
    }
  }
  return rates;
}

function computeCMGR(values: number[]): number {
  if (values.length < 2) return 0;
  const first = values[0]!;
  const last = values[values.length - 1]!;
  if (first <= 0 || last <= 0) return 0;

  const n = values.length - 1;
  const cmgr = (Math.pow(last / first, 1 / n) - 1) * 100;
  return Math.round(cmgr * 100) / 100;
}
