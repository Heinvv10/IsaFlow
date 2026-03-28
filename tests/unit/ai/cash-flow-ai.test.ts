/**
 * TDD: AI-Enhanced Cash Flow Forecasting Tests
 * RED phase.
 */

import { describe, it, expect } from 'vitest';
import {
  scorePaymentProbability,
  detectSeasonalPattern,
  buildForecastScenario,
  buildForecastNarrativePrompt,
  parseForecastNarrative,
  calculateWeeklyForecast,
  type PaymentHistory,
  type SeasonalPattern,
  type ForecastScenario,
  type WeeklyForecast,
} from '@/modules/accounting/services/cashFlowAIService';

// ═══════════════════════════════════════════════════════════════════════════
// PAYMENT PROBABILITY SCORING
// ═══════════════════════════════════════════════════════════════════════════

describe('Payment Probability Scoring', () => {
  it('scores reliable payer highly', () => {
    const history: PaymentHistory = {
      totalInvoices: 20,
      paidOnTime: 18,
      paidLate: 2,
      unpaid: 0,
      avgDaysToPayment: 15,
    };
    const score = scorePaymentProbability(history);
    expect(score.probability).toBeGreaterThanOrEqual(0.85);
    expect(score.rating).toBe('reliable');
  });

  it('scores poor payer low', () => {
    const history: PaymentHistory = {
      totalInvoices: 10,
      paidOnTime: 2,
      paidLate: 5,
      unpaid: 3,
      avgDaysToPayment: 60,
    };
    const score = scorePaymentProbability(history);
    expect(score.probability).toBeLessThan(0.5);
    expect(score.rating).toBe('poor');
  });

  it('handles new customer (no history)', () => {
    const score = scorePaymentProbability({
      totalInvoices: 0, paidOnTime: 0, paidLate: 0, unpaid: 0, avgDaysToPayment: 0,
    });
    expect(score.probability).toBeCloseTo(0.5, 1); // Default 50%
    expect(score.rating).toBe('unknown');
  });

  it('penalizes unpaid invoices heavily', () => {
    const withUnpaid = scorePaymentProbability({ totalInvoices: 10, paidOnTime: 5, paidLate: 0, unpaid: 5, avgDaysToPayment: 30 });
    const withoutUnpaid = scorePaymentProbability({ totalInvoices: 10, paidOnTime: 10, paidLate: 0, unpaid: 0, avgDaysToPayment: 15 });
    expect(withUnpaid.probability).toBeLessThan(withoutUnpaid.probability);
  });

  it('returns estimated collection days', () => {
    const score = scorePaymentProbability({ totalInvoices: 10, paidOnTime: 8, paidLate: 2, unpaid: 0, avgDaysToPayment: 20 });
    expect(score.estimatedDays).toBeDefined();
    expect(score.estimatedDays).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SEASONAL PATTERN DETECTION
// ═══════════════════════════════════════════════════════════════════════════

describe('Seasonal Pattern Detection', () => {
  it('detects December spike', () => {
    const monthlyData = [
      100000, 100000, 100000, 100000, 100000, 100000,
      100000, 100000, 100000, 100000, 100000, 180000, // Dec spike
    ];
    const pattern = detectSeasonalPattern(monthlyData);
    expect(pattern.hasSeasonality).toBe(true);
    expect(pattern.peakMonth).toBe(12);
  });

  it('detects no seasonality in flat data', () => {
    const monthlyData = [100000, 102000, 99000, 101000, 100500, 99500, 100000, 101000, 99000, 100500, 100000, 101000];
    const pattern = detectSeasonalPattern(monthlyData);
    expect(pattern.hasSeasonality).toBe(false);
  });

  it('returns seasonal factors per month', () => {
    const monthlyData = [80000, 90000, 100000, 110000, 120000, 130000, 130000, 120000, 110000, 100000, 90000, 150000];
    const pattern = detectSeasonalPattern(monthlyData);
    expect(pattern.factors.length).toBe(12);
    expect(pattern.factors.every(f => f > 0)).toBe(true);
  });

  it('handles insufficient data', () => {
    const pattern = detectSeasonalPattern([100000, 200000]);
    expect(pattern.hasSeasonality).toBe(false);
    expect(pattern.factors.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO MODELING
// ═══════════════════════════════════════════════════════════════════════════

describe('Forecast Scenario Modeling', () => {
  it('builds optimistic scenario', () => {
    const scenario = buildForecastScenario('optimistic', {
      baseRevenue: 100000, baseExpenses: 70000, cashBalance: 200000, months: 3,
    });
    expect(scenario.name).toBe('optimistic');
    expect(scenario.points.length).toBe(3);
    expect(scenario.points[0]!.inflow).toBeGreaterThan(100000); // Optimistic = above base
  });

  it('builds pessimistic scenario', () => {
    const scenario = buildForecastScenario('pessimistic', {
      baseRevenue: 100000, baseExpenses: 70000, cashBalance: 200000, months: 3,
    });
    expect(scenario.name).toBe('pessimistic');
    expect(scenario.points[0]!.inflow).toBeLessThan(100000);
  });

  it('builds base scenario matching inputs', () => {
    const scenario = buildForecastScenario('base', {
      baseRevenue: 100000, baseExpenses: 70000, cashBalance: 200000, months: 3,
    });
    expect(scenario.points[0]!.inflow).toBe(100000);
    expect(scenario.points[0]!.outflow).toBe(70000);
  });

  it('tracks running cash balance', () => {
    const scenario = buildForecastScenario('base', {
      baseRevenue: 100000, baseExpenses: 70000, cashBalance: 200000, months: 3,
    });
    // Month 1: 200000 + 100000 - 70000 = 230000
    expect(scenario.points[0]!.closingBalance).toBe(230000);
    // Month 2: 230000 + 100000 - 70000 = 260000
    expect(scenario.points[1]!.closingBalance).toBe(260000);
  });

  it('detects cash shortfall', () => {
    const scenario = buildForecastScenario('pessimistic', {
      baseRevenue: 30000, baseExpenses: 100000, cashBalance: 50000, months: 3,
    });
    const hasShortfall = scenario.points.some(p => p.closingBalance < 0);
    expect(hasShortfall).toBe(true);
    expect(scenario.alerts.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13-WEEK ROLLING FORECAST
// ═══════════════════════════════════════════════════════════════════════════

describe('Weekly Forecast (13-week)', () => {
  it('generates 13 weeks of forecasts', () => {
    const forecast = calculateWeeklyForecast({
      openingBalance: 500000,
      weeklyInflow: 50000,
      weeklyOutflow: 40000,
      weeks: 13,
    });
    expect(forecast.weeks.length).toBe(13);
  });

  it('calculates running balance per week', () => {
    const forecast = calculateWeeklyForecast({
      openingBalance: 100000, weeklyInflow: 30000, weeklyOutflow: 25000, weeks: 4,
    });
    // Week 1: 100000 + 30000 - 25000 = 105000
    expect(forecast.weeks[0]!.closingBalance).toBe(105000);
    // Week 4: should increase by 5000 each week
    expect(forecast.weeks[3]!.closingBalance).toBe(120000);
  });

  it('flags weeks below minimum threshold', () => {
    const forecast = calculateWeeklyForecast({
      openingBalance: 50000, weeklyInflow: 10000, weeklyOutflow: 20000, weeks: 13,
      minimumBalance: 20000,
    });
    expect(forecast.alertWeeks.length).toBeGreaterThan(0);
  });

  it('calculates lowest point', () => {
    const forecast = calculateWeeklyForecast({
      openingBalance: 100000, weeklyInflow: 10000, weeklyOutflow: 15000, weeks: 10,
    });
    expect(forecast.lowestBalance).toBeLessThan(100000);
    expect(forecast.lowestWeek).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// FORECAST NARRATIVE
// ═══════════════════════════════════════════════════════════════════════════

describe('Forecast Narrative', () => {
  it('builds prompt with forecast data', () => {
    const prompt = buildForecastNarrativePrompt({
      currentBalance: 500000,
      projectedBalance: 650000,
      months: 3,
      lowestPoint: 450000,
      lowestMonth: 'May 2026',
    });
    expect(prompt).toContain('500');
    expect(prompt).toContain('650');
    expect(prompt).toContain('May');
  });

  it('parses narrative response', () => {
    const result = parseForecastNarrative('{"summary":"Cash position is healthy","risks":["Seasonal dip in May"],"actions":["Build cash reserves"]}');
    expect(result).toBeDefined();
    expect(result!.summary).toContain('healthy');
    expect(result!.risks.length).toBeGreaterThan(0);
  });

  it('handles plain text fallback', () => {
    const result = parseForecastNarrative('Cash flow looks stable for the next quarter. No immediate concerns.');
    expect(result).toBeDefined();
    expect(result!.summary.length).toBeGreaterThan(0);
  });
});
