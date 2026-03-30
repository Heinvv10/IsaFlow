/**
 * TDD: Executive Summary Service
 * Tests for building executive dashboard summaries.
 */

import { describe, it, expect } from 'vitest';
import {
  buildExecutiveSummary,
  generateHighlights,
  summarizeCashPosition,
  generateAlerts,
  type ExecutiveSummaryInput,
} from '@/modules/accounting/services/executiveSummaryService';

const sampleInput: ExecutiveSummaryInput = {
  period: '2026-01',
  companyName: 'Test Co',
  revenue: 1000000,
  costOfSales: 600000,
  operatingExpenses: 200000,
  netProfit: 200000,
  totalAssets: 2000000,
  totalLiabilities: 800000,
  totalEquity: 1200000,
  currentAssets: 500000,
  currentLiabilities: 300000,
  cash: 150000,
  accountsReceivable: 200000,
  accountsPayable: 100000,
  inventory: 0,
  priorRevenue: 900000,
  priorNetProfit: 150000,
};

describe('Executive Summary Service', () => {
  it('builds executive summary with all required fields', () => {
    const summary = buildExecutiveSummary(sampleInput, '2026-01-01', '2026-01-31');
    expect(summary).toHaveProperty('period');
    expect(summary).toHaveProperty('companyName');
    expect(summary).toHaveProperty('kpis');
    expect(summary).toHaveProperty('cashPosition');
    expect(summary).toHaveProperty('highlights');
    expect(summary).toHaveProperty('alerts');
    expect(summary).toHaveProperty('generatedAt');
  });

  it('calculates revenue growth correctly', () => {
    const summary = buildExecutiveSummary(sampleInput, '2026-01-01', '2026-01-31');
    // (1000000 - 900000) / 900000 * 100 = 11.11%
    expect(summary.kpis.revenueGrowth).toBeCloseTo(11.11, 0);
  });

  it('calculates profit margin correctly', () => {
    const summary = buildExecutiveSummary(sampleInput, '2026-01-01', '2026-01-31');
    // 200000 / 1000000 * 100 = 20%
    expect(summary.kpis.netProfitMargin).toBeCloseTo(20, 1);
  });

  it('generates highlights with positive items', () => {
    const highlights = generateHighlights(sampleInput);
    expect(Array.isArray(highlights)).toBe(true);
    expect(highlights.length).toBeGreaterThan(0);
    expect(highlights[0]).toEqual(expect.objectContaining({ type: expect.any(String), message: expect.any(String) }));
  });

  it('summarizes cash position accurately', () => {
    const cash = summarizeCashPosition(sampleInput);
    expect(cash.cashBalance).toBe(150000);
    expect(cash.netWorkingCapital).toBe(200000); // 500000 - 300000
    expect(cash.currentRatio).toBeCloseTo(1.67, 1);
  });

  it('generates alert when net profit declines significantly', () => {
    const alerts = generateAlerts({ ...sampleInput, netProfit: -50000 });
    expect(alerts.some(a => a.severity === 'danger')).toBe(true);
  });

  it('returns empty alerts for healthy financials', () => {
    const alerts = generateAlerts(sampleInput);
    // May have minor alerts but no danger
    const dangerAlerts = alerts.filter(a => a.severity === 'danger');
    expect(dangerAlerts.length).toBe(0);
  });
});
