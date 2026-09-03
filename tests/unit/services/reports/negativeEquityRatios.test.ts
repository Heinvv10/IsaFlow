/**
 * AN-07: negative equity must not score as healthy.
 *
 * `safeDiv` returns 0 when the denominator is 0, and a real (sign-flipped)
 * number when it is negative. Two endpoints then clamped equity with
 * `Math.max(1, totalEquity(figures))`, so an insolvent company divided by 1.
 *
 * Velocity Fibre as at 2026-09-30: assets 89,049,547.41, liabilities
 * 106,131,424.03, equity -17,081,876.62, net profit 11,274,884.13. Clamped,
 * debt-to-equity reads 106,131,424 : 1 and ROE divides 11.27m by 1. Unclamped
 * but unguarded, debt-to-equity is -6.21 — and because that KPI is
 * lowerIsBetter, a NEGATIVE reading scores GREEN. Insolvency would present as
 * the healthiest possible result.
 *
 * A ratio whose denominator is <= 0 is not a number that is merely unusual: it
 * is arithmetically meaningless. It must say so.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  calculateFinancialRatios,
  calculateExtendedRatios,
  type FinancialData,
} from '@/modules/accounting/services/reports/reportingEngineService';
import { buildKPIScorecard, type KPITargetConfig } from '@/modules/accounting/services/reports/kpiScorecardService';
import { EQUITY_DIVIDED_RATIOS } from '@/modules/accounting/services/reports/ratioBasis';

/** Velocity Fibre's real figures, as at 2026-09-30 with from = 2026-01-01. */
const VELOCITY: FinancialData = {
  revenue: 99_530_987.17,
  costOfSales: 2_628_487.64,
  operatingExpenses: 113_490_297.39,
  netProfit: 11_274_884.13,
  totalAssets: 89_049_547.41,
  totalLiabilities: 106_131_424.03,
  totalEquity: -17_081_876.62,
  currentAssets: 89_049_547.41,
  currentLiabilities: 106_131_424.03,
  inventory: 0,
  accountsReceivable: 34_248_931.40,
  accountsPayable: 13_008_834.83,
  cash: 234_353.19,
};

const solvent: FinancialData = { ...VELOCITY, totalEquity: 25_000_000 };
const zeroEquity: FinancialData = { ...VELOCITY, totalEquity: 0 };

describe('equity-divided ratios with negative equity', () => {
  it('returns null rather than a sign-flipped number', () => {
    const r = calculateFinancialRatios(VELOCITY);
    expect(r.debtToEquity).toBeNull();
    expect(r.returnOnEquity).toBeNull();
  });

  it('returns null on the extended ratios too', () => {
    const r = calculateExtendedRatios(VELOCITY);
    expect(r.equityMultiplier).toBeNull();
    expect(r.dupontLeverage).toBeNull();
  });

  it('never yields 0, Infinity or NaN for an unmeaningful ratio', () => {
    const r = calculateExtendedRatios(VELOCITY);
    for (const v of [r.debtToEquity, r.returnOnEquity, r.equityMultiplier, r.dupontLeverage]) {
      expect(v).toBeNull();
      expect(Number.isNaN(v as unknown as number)).toBe(false);
    }
  });

  it('gives a reason naming the condition', () => {
    const r = calculateFinancialRatios(VELOCITY);
    expect(r.notMeaningful.debtToEquity).toMatch(/negative/i);
    expect(r.notMeaningful.returnOnEquity).toMatch(/negative/i);
  });

  it('carries a reason for EVERY equity-divided ratio, not just the nulls', () => {
    // Nulling the value and explaining it are separate steps; a ratio can be
    // null with nothing to show the user why.
    //
    // The four names are written out rather than read from
    // EQUITY_DIVIDED_RATIOS on purpose: iterating the very list under test
    // makes the assertion self-referential, so dropping an entry from the list
    // would silently stop checking it.
    const expected = ['debtToEquity', 'returnOnEquity', 'equityMultiplier', 'dupontLeverage'];
    const r = calculateExtendedRatios(VELOCITY) as unknown as Record<string, unknown> & {
      notMeaningful: Record<string, string>;
    };
    for (const key of expected) {
      expect(r[key], `${key} should be null`).toBeNull();
      expect(r.notMeaningful[key], `${key} has no reason`).toMatch(/negative/i);
    }
    expect(Object.keys(r.notMeaningful).sort()).toEqual([...expected].sort());
    // And the exported list must still name exactly those four.
    expect([...EQUITY_DIVIDED_RATIOS].sort()).toEqual([...expected].sort());
  });

  it('distinguishes zero equity from negative equity in the reason', () => {
    const zero = calculateFinancialRatios(zeroEquity);
    expect(zero.debtToEquity).toBeNull();
    expect(zero.notMeaningful.debtToEquity).toMatch(/no equity|zero/i);
    expect(zero.notMeaningful.debtToEquity).not.toMatch(/negative/i);
  });

  it('leaves a solvent company completely unchanged', () => {
    const r = calculateExtendedRatios(solvent);
    expect(r.debtToEquity).toBeCloseTo(4.25, 2);
    expect(r.returnOnEquity).toBeCloseTo(45.1, 1);
    expect(r.equityMultiplier).toBeCloseTo(3.56, 2);
    expect(r.notMeaningful.debtToEquity).toBeUndefined();
  });

  it('does not disturb ratios with a different denominator', () => {
    const r = calculateExtendedRatios(VELOCITY);
    expect(r.returnOnAssets).toBeCloseTo(12.66, 1);
    expect(r.debtRatio).toBeCloseTo(1.19, 2);
    expect(r.currentRatio).toBeCloseTo(0.84, 2);
  });
});

describe('KPI scorecard with negative equity', () => {
  const TARGETS: KPITargetConfig[] = [
    { ratioKey: 'debtToEquity', target: 0.5, warningThreshold: 1.0, criticalThreshold: 1.5, lowerIsBetter: true },
    { ratioKey: 'returnOnEquity', target: 15, warningThreshold: 10, criticalThreshold: 5, lowerIsBetter: false },
    { ratioKey: 'currentRatio', target: 1.5, warningThreshold: 1.2, criticalThreshold: 1.0, lowerIsBetter: false },
  ];

  it('never scores an insolvent company green on debt-to-equity', () => {
    const card = buildKPIScorecard(calculateExtendedRatios(VELOCITY), TARGETS);
    const dte = card.find((i) => i.ratioKey === 'debtToEquity')!;
    expect(dte.status).not.toBe('green');
    expect(dte.status).toBe('not_meaningful');
    expect(dte.value).toBeNull();
    expect(dte.reason).toMatch(/negative/i);
  });

  it('marks return on equity not meaningful rather than scoring it', () => {
    const card = buildKPIScorecard(calculateExtendedRatios(VELOCITY), TARGETS);
    const roe = card.find((i) => i.ratioKey === 'returnOnEquity')!;
    expect(roe.status).toBe('not_meaningful');
    expect(roe.value).toBeNull();
  });

  it('still scores ratios that do not depend on equity', () => {
    const card = buildKPIScorecard(calculateExtendedRatios(VELOCITY), TARGETS);
    const cr = card.find((i) => i.ratioKey === 'currentRatio')!;
    expect(cr.status).toBe('red');
    expect(cr.value).toBeCloseTo(0.84, 2);
  });

  it('excludes not-meaningful items from the green/amber/red counts', () => {
    const card = buildKPIScorecard(calculateExtendedRatios(VELOCITY), TARGETS);
    const scored = card.filter((i) => i.status !== 'not_meaningful');
    expect(scored).toHaveLength(1);
    expect(card).toHaveLength(3);
  });
});

describe('no endpoint clamps equity', () => {
  /**
   * The ratio engine can only report "not meaningful" if it is actually handed
   * the negative number. `reports-kpi-scorecard` and `reports-ratio-trends`
   * both did `Math.max(1, totalEquity(figures))`, so an insolvent company
   * arrived at the engine with equity = 1 and every guard above this line was
   * bypassed. Unit tests on the engine cannot see that — they never go through
   * the endpoint — so the clamp is checked at the source.
   */
  const ENDPOINTS = [
    'reports-kpi-scorecard',
    'reports-ratio-trends',
    'reports-ratios',
    'reports-extended-ratios',
    'reports-executive-summary',
    'reports-pack',
    'reports-html',
    'reports-three-way-forecast',
    'ai-commentary',
  ];
  const root = join(__dirname, '../../../..');

  it.each(ENDPOINTS)('%s passes equity through unmodified', (name) => {
    const src = readFileSync(join(root, `pages/api/accounting/${name}.ts`), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ');
    // No clamping, flooring, or absolute value applied to equity.
    expect(src).not.toMatch(/Math\.(max|abs)\([^)]*totalEquity/);
    expect(src).not.toMatch(/totalEquity[^,)\n]*\|\|\s*1\b/);
  });
});
