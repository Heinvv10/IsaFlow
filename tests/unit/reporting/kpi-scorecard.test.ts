/**
 * TDD: KPI Scorecard Engine
 * Tests for traffic-light scoring of financial KPIs.
 */

import { describe, it, expect } from 'vitest';
import { buildKPIScorecard, type KPITargetConfig } from '@/modules/accounting/services/kpiScorecardService';
import type { ExtendedRatioResult } from '@/modules/accounting/services/reportingEngineService';

const sampleRatios: ExtendedRatioResult = {
  grossProfitMargin: 40, netProfitMargin: 20, operatingProfitMargin: 20,
  currentRatio: 1.67, quickRatio: 1.33, debtToEquity: 0.67,
  returnOnAssets: 10, returnOnEquity: 16.67, debtorDays: 73, creditorDays: 91, inventoryTurnover: 6,
  ebitda: 260000, ebitdaMargin: 26, roce: 11.76, interestCoverage: 6.67,
  debtRatio: 0.40, equityMultiplier: 1.67, cashRatio: 0.50, workingCapital: 200000,
  operatingCashFlowRatio: 0.83, assetTurnover: 0.50, receivablesTurnover: 5.00,
  payablesTurnover: 4.00, inventoryDays: 60.83, cashConversionCycle: 42.58,
  freeCashFlow: 170000, revenuePerEmployee: 100000,
  dupontMargin: 20, dupontTurnover: 0.50, dupontLeverage: 1.67,
};

const targets: KPITargetConfig[] = [
  { ratioKey: 'grossProfitMargin', target: 35, warningThreshold: 30, criticalThreshold: 25, lowerIsBetter: false },
  { ratioKey: 'currentRatio', target: 1.5, warningThreshold: 1.2, criticalThreshold: 1.0, lowerIsBetter: false },
  { ratioKey: 'debtToEquity', target: 0.5, warningThreshold: 0.8, criticalThreshold: 1.0, lowerIsBetter: true },
  { ratioKey: 'debtorDays', target: 60, warningThreshold: 75, criticalThreshold: 90, lowerIsBetter: true },
  { ratioKey: 'netProfitMargin', target: 15, warningThreshold: 10, criticalThreshold: 5, lowerIsBetter: false },
];

describe('KPI Scorecard Engine', () => {
  it('assigns green when value meets target', () => {
    const sc = buildKPIScorecard(sampleRatios, targets);
    expect(sc.find(s => s.ratioKey === 'grossProfitMargin')!.status).toBe('green');
  });

  it('assigns amber when within warning threshold', () => {
    const sc = buildKPIScorecard({ ...sampleRatios, grossProfitMargin: 32 }, targets);
    expect(sc.find(s => s.ratioKey === 'grossProfitMargin')!.status).toBe('amber');
  });

  it('assigns red when outside acceptable range', () => {
    const sc = buildKPIScorecard({ ...sampleRatios, grossProfitMargin: 22 }, targets);
    expect(sc.find(s => s.ratioKey === 'grossProfitMargin')!.status).toBe('red');
  });

  it('inverts thresholds for lower-is-better KPIs', () => {
    const sc1 = buildKPIScorecard(sampleRatios, targets);
    expect(sc1.find(s => s.ratioKey === 'debtToEquity')!.status).toBe('amber');

    const sc2 = buildKPIScorecard({ ...sampleRatios, debtToEquity: 0.40 }, targets);
    expect(sc2.find(s => s.ratioKey === 'debtToEquity')!.status).toBe('green');

    const sc3 = buildKPIScorecard({ ...sampleRatios, debtToEquity: 1.2 }, targets);
    expect(sc3.find(s => s.ratioKey === 'debtToEquity')!.status).toBe('red');
  });

  it('calculates percentage of target achieved', () => {
    const sc = buildKPIScorecard(sampleRatios, targets);
    expect(sc.find(s => s.ratioKey === 'grossProfitMargin')!.percentOfTarget).toBeCloseTo(114.29, 0);
  });

  it('builds scorecard with correct structure', () => {
    const sc = buildKPIScorecard(sampleRatios, targets);
    expect(sc.length).toBe(targets.length);
    sc.forEach(item => {
      expect(item.ratioKey).toBeDefined();
      expect(item.name).toBeDefined();
      expect(typeof item.value).toBe('number');
      expect(['green', 'amber', 'red']).toContain(item.status);
    });
  });

  it('returns empty for no targets', () => {
    expect(buildKPIScorecard(sampleRatios, []).length).toBe(0);
  });

  it('handles unknown ratio key', () => {
    const bad: KPITargetConfig[] = [
      { ratioKey: 'nonExistent', target: 50, warningThreshold: 40, criticalThreshold: 30, lowerIsBetter: false },
    ];
    const sc = buildKPIScorecard(sampleRatios, bad);
    expect(sc.length).toBeLessThanOrEqual(1);
    if (sc.length === 1) expect(sc[0]!.value).toBe(0);
  });
});
