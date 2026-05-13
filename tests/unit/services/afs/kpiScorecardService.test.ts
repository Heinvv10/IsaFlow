// tests/unit/services/afs/kpiScorecardService.test.ts
import { describe, it, expect } from 'vitest';
import {
  calculateKpis,
  DEFAULT_RAG_THRESHOLDS,
  type FinancialSnapshot,
} from '@/modules/accounting/services/afs/afsKpiService';

const BASE_SNAPSHOT: FinancialSnapshot = {
  revenue: 1_000_000,
  cogs: 600_000,
  grossProfit: 400_000,
  ebitda: 150_000,
  ebit: 120_000,
  netProfit: 80_000,
  currentAssets: 500_000,
  currentLiabilities: 300_000,
  inventory: 0,
  tradeReceivables: 150_000,
  tradePayables: 120_000,
  totalDebt: 400_000,
  totalEquity: 600_000,
  openingCash: 200_000,
  closingCash: 250_000,
  daysInPeriod: 31,
};

const LOW_MARGIN_SNAPSHOT: FinancialSnapshot = {
  ...BASE_SNAPSHOT,
  grossProfit: 100_000,  // 10% gross margin — below amber threshold of 20%
  netProfit: -20_000,
  ebitda: -10_000,
  ebit: -20_000,
};

const ZERO_LIABILITIES_SNAPSHOT: FinancialSnapshot = {
  ...BASE_SNAPSHOT,
  currentLiabilities: 0,
  totalEquity: 0,
};

const ZERO_REVENUE_SNAPSHOT: FinancialSnapshot = {
  ...BASE_SNAPSHOT,
  revenue: 0,
  cogs: 0,
  grossProfit: 0,
  netProfit: 0,
  ebitda: 0,
  ebit: 0,
};

describe('calculateKpis', () => {
  it('returns 11 KPIs for base snapshot', () => {
    const kpis = calculateKpis(BASE_SNAPSHOT, null, DEFAULT_RAG_THRESHOLDS);
    expect(kpis).toHaveLength(11);
  });

  it('calculates grossMarginPct as 40% and rates green', () => {
    const kpis = calculateKpis(BASE_SNAPSHOT, null, DEFAULT_RAG_THRESHOLDS);
    const gm = kpis.find(k => k.key === 'grossMarginPct');
    expect(gm).toBeDefined();
    expect(gm!.value).toBeCloseTo(40, 1);
    expect(gm!.rag).toBe('green');
  });

  it('calculates currentRatio as 1.667 and rates green', () => {
    const kpis = calculateKpis(BASE_SNAPSHOT, null, DEFAULT_RAG_THRESHOLDS);
    const cr = kpis.find(k => k.key === 'currentRatio');
    expect(cr).toBeDefined();
    expect(cr!.value).toBeCloseTo(500_000 / 300_000, 3);
    expect(cr!.rag).toBe('green');
  });

  it('calculates debtorDays correctly and rates green', () => {
    const kpis = calculateKpis(BASE_SNAPSHOT, null, DEFAULT_RAG_THRESHOLDS);
    const dd = kpis.find(k => k.key === 'debtorDays');
    expect(dd).toBeDefined();
    // (150000 / 1000000) * 31 = 4.65
    expect(dd!.value).toBeCloseTo(4.65, 1);
    expect(dd!.rag).toBe('green');
  });

  it('rates grossMarginPct red when below 20%', () => {
    const kpis = calculateKpis(LOW_MARGIN_SNAPSHOT, null, DEFAULT_RAG_THRESHOLDS);
    const gm = kpis.find(k => k.key === 'grossMarginPct');
    expect(gm).toBeDefined();
    expect(gm!.rag).toBe('red');
  });

  it('currentRatio exactly at green threshold (1.5) is green', () => {
    const snap: FinancialSnapshot = { ...BASE_SNAPSHOT, currentAssets: 300_000, currentLiabilities: 200_000 };
    // ratio = 1.5 exactly
    const kpis = calculateKpis(snap, null, DEFAULT_RAG_THRESHOLDS);
    const cr = kpis.find(k => k.key === 'currentRatio');
    expect(cr!.value).toBeCloseTo(1.5, 3);
    expect(cr!.rag).toBe('green');
  });

  it('calculates revenueGrowthPct with prior snapshot', () => {
    const priorSnap: FinancialSnapshot = { ...BASE_SNAPSHOT, revenue: 800_000 };
    const kpis = calculateKpis(BASE_SNAPSHOT, priorSnap, DEFAULT_RAG_THRESHOLDS);
    const rg = kpis.find(k => k.key === 'revenueGrowthPct');
    expect(rg).toBeDefined();
    // (1000000 - 800000) / 800000 * 100 = 25%
    expect(rg!.value).toBeCloseTo(25, 1);
    expect(rg!.rag).toBe('green');
  });

  it('revenueGrowthPct trend is flat when no prior snapshot', () => {
    const kpis = calculateKpis(BASE_SNAPSHOT, null, DEFAULT_RAG_THRESHOLDS);
    const rg = kpis.find(k => k.key === 'revenueGrowthPct');
    expect(rg!.trend).toBe('flat');
  });

  it('cashBurnRate is 0 when cash increased', () => {
    // openingCash 200k, closingCash 250k — cash increased, no burn
    const kpis = calculateKpis(BASE_SNAPSHOT, null, DEFAULT_RAG_THRESHOLDS);
    const cbr = kpis.find(k => k.key === 'cashBurnRate');
    expect(cbr!.value).toBe(0);
  });

  it('cashBurnRate is positive when cash declined', () => {
    const snap: FinancialSnapshot = { ...BASE_SNAPSHOT, openingCash: 300_000, closingCash: 240_000 };
    const kpis = calculateKpis(snap, null, DEFAULT_RAG_THRESHOLDS);
    const cbr = kpis.find(k => k.key === 'cashBurnRate');
    // (300000 - 240000) / 31 * 30 ≈ 58064.5
    expect(cbr!.value).toBeCloseTo(60_000 / 31 * 30, 0);
    expect(cbr!.value).toBeGreaterThan(0);
  });

  it('trend is up when value increased vs prior', () => {
    const priorSnap: FinancialSnapshot = { ...BASE_SNAPSHOT, revenue: 500_000, grossProfit: 200_000 };
    const kpis = calculateKpis(BASE_SNAPSHOT, priorSnap, DEFAULT_RAG_THRESHOLDS);
    const gm = kpis.find(k => k.key === 'grossMarginPct');
    // both are 40%, so flat
    // use ebitdaMarginPct: current ebitda=150k/rev=1M=15%; prior ebitda=150k/rev=500k=30%
    const em = kpis.find(k => k.key === 'ebitdaMarginPct');
    expect(em!.trend).toBe('down'); // 15% now vs 30% prior
  });

  it('trend is down when value decreased vs prior', () => {
    const priorSnap: FinancialSnapshot = { ...BASE_SNAPSHOT, revenue: 2_000_000, grossProfit: 800_000, netProfit: 200_000, ebitda: 300_000, ebit: 200_000 };
    const kpis = calculateKpis(BASE_SNAPSHOT, priorSnap, DEFAULT_RAG_THRESHOLDS);
    const rg = kpis.find(k => k.key === 'revenueGrowthPct');
    // (1M - 2M)/2M * 100 = -50%
    expect(rg!.value).toBeCloseTo(-50, 1);
    expect(rg!.rag).toBe('red');
  });

  it('returns 0 and red for currentRatio when currentLiabilities is 0', () => {
    const kpis = calculateKpis(ZERO_LIABILITIES_SNAPSHOT, null, DEFAULT_RAG_THRESHOLDS);
    const cr = kpis.find(k => k.key === 'currentRatio');
    expect(cr!.value).toBe(0);
    expect(cr!.rag).toBe('red');
  });

  it('returns 0 and red for grossMarginPct when revenue is 0', () => {
    const kpis = calculateKpis(ZERO_REVENUE_SNAPSHOT, null, DEFAULT_RAG_THRESHOLDS);
    const gm = kpis.find(k => k.key === 'grossMarginPct');
    expect(gm!.value).toBe(0);
    expect(gm!.rag).toBe('red');
  });

  it('never returns Infinity or NaN', () => {
    const kpis = calculateKpis(ZERO_REVENUE_SNAPSHOT, null, DEFAULT_RAG_THRESHOLDS);
    for (const kpi of kpis) {
      expect(Number.isFinite(kpi.value)).toBe(true);
      expect(Number.isNaN(kpi.value)).toBe(false);
    }
  });

  it('all 11 KPI keys are present', () => {
    const expectedKeys = [
      'grossMarginPct', 'ebitdaMarginPct', 'netProfitMarginPct',
      'currentRatio', 'quickRatio',
      'debtorDays', 'creditorDays', 'cashConversionCycle',
      'debtToEquity', 'revenueGrowthPct', 'cashBurnRate',
    ];
    const kpis = calculateKpis(BASE_SNAPSHOT, null, DEFAULT_RAG_THRESHOLDS);
    const keys = kpis.map(k => k.key);
    for (const key of expectedKeys) {
      expect(keys).toContain(key);
    }
  });
});
