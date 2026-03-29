/**
 * TDD: Trend Analysis Engine
 * Tests for growth rates, moving averages, anomaly detection.
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeTrend,
  calculateMovingAverage,
  detectAnomalies,
  type TrendAnalysis,
} from '@/modules/accounting/services/trendAnalysisService';

describe('Trend Analysis Engine', () => {
  const revenueData = [
    { period: 'Oct 2025', value: 150000 },
    { period: 'Nov 2025', value: 160000 },
    { period: 'Dec 2025', value: 180000 },
    { period: 'Jan 2026', value: 170000 },
    { period: 'Feb 2026', value: 200000 },
    { period: 'Mar 2026', value: 217391 },
  ];

  it('computes month-over-month growth rates', () => {
    const result = analyzeTrend(revenueData);
    expect(result.growthRates.length).toBe(5); // N-1 growth rates
    // Oct->Nov: (160000-150000)/150000 = 6.67%
    expect(result.growthRates[0]).toBeCloseTo(6.67, 0);
  });

  it('calculates 3-month moving average', () => {
    const result = analyzeTrend(revenueData);
    expect(result.movingAverage3.length).toBe(6);
    // First 2 should be null (not enough data)
    expect(result.movingAverage3[0]).toBeNull();
    expect(result.movingAverage3[1]).toBeNull();
    // Third: avg of 150000, 160000, 180000 = 163333
    expect(result.movingAverage3[2]).toBeCloseTo(163333, -2);
  });

  it('calculates compound monthly growth rate (CMGR)', () => {
    const result = analyzeTrend(revenueData);
    // CMGR = (last/first)^(1/n) - 1
    expect(typeof result.cmgr).toBe('number');
    expect(result.cmgr).toBeGreaterThan(0); // Upward trend
  });

  it('detects anomalies (values > 2 std deviations)', () => {
    const dataWithAnomaly = [
      { period: 'Jan', value: 100000 },
      { period: 'Feb', value: 105000 },
      { period: 'Mar', value: 102000 },
      { period: 'Apr', value: 98000 },
      { period: 'May', value: 250000 }, // Anomaly
      { period: 'Jun', value: 101000 },
    ];
    const result = analyzeTrend(dataWithAnomaly);
    expect(result.anomalies.length).toBeGreaterThan(0);
    expect(result.anomalies).toContain(4); // Index of the anomaly
  });

  it('handles periods with missing/sparse data', () => {
    const sparse = [
      { period: 'Jan', value: 100000 },
      { period: 'Jun', value: 150000 },
    ];
    const result = analyzeTrend(sparse);
    expect(result.growthRates.length).toBe(1);
    expect(result.dataPoints.length).toBe(2);
  });

  it('returns trend data for any metric', () => {
    const result = analyzeTrend(revenueData);
    expect(result.dataPoints).toEqual(revenueData);
    expect(result.movingAverage3).toBeDefined();
    expect(result.growthRates).toBeDefined();
    expect(result.cmgr).toBeDefined();
    expect(result.anomalies).toBeDefined();
  });
});

describe('Moving Average Helper', () => {
  it('calculates correctly', () => {
    const values = [10, 20, 30, 40, 50];
    const ma = calculateMovingAverage(values, 3);
    expect(ma[0]).toBeNull();
    expect(ma[1]).toBeNull();
    expect(ma[2]).toBeCloseTo(20, 0); // avg(10,20,30)
    expect(ma[3]).toBeCloseTo(30, 0); // avg(20,30,40)
    expect(ma[4]).toBeCloseTo(40, 0); // avg(30,40,50)
  });
});

describe('Anomaly Detection Helper', () => {
  it('returns empty for uniform data', () => {
    const values = [100, 101, 99, 100, 102, 98];
    const anomalies = detectAnomalies(values, 2);
    expect(anomalies.length).toBe(0);
  });

  it('detects outlier', () => {
    const values = [100, 100, 100, 100, 500, 100];
    const anomalies = detectAnomalies(values, 2);
    expect(anomalies).toContain(4);
  });
});
