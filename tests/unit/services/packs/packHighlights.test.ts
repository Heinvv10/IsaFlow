import { describe, expect, it } from 'vitest';
import { buildHighlightTiles } from '@/modules/accounting/services/packs/pages/packHighlights';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

function figures(overrides: Partial<ReportPackFigures>): ReportPackFigures {
  return {
    companyName: 'Test Co',
    period: '2026-01-01 to 2026-01-31',
    revenue: 1_000_000,
    costOfSales: 600_000,
    operatingExpenses: 250_000,
    otherIncome: 0,
    otherExpenses: 0,
    operatingProfit: 150_000,
    netProfit: 120_000,
    totalAssets: 900_000,
    totalLiabilities: 300_000,
    totalEquity: 600_000,
    currentAssets: 400_000,
    currentLiabilities: 200_000,
    cash: 150_000,
    accountsReceivable: 90_000,
    accountsPayable: 60_000,
    inventory: 50_000,
    operatingCashFlow: 140_000,
    capitalExpenditure: 20_000,
    inventoryCaveat: null,
    classificationCaveat: null,
    ...overrides,
  };
}

const trend: PackTrendPoint[] = [
  { month: '2025-12', label: 'Dec 2025', revenue: 900_000, expenses: 810_000, netProfit: 90_000 },
  { month: '2026-01', label: 'Jan 2026', revenue: 1_000_000, expenses: 850_000, netProfit: 120_000 },
];

const setWithPrior: PackFigureSet = {
  current: figures({}),
  currentWindow: { start: '2026-01-01', end: '2026-01-31' },
  prior: figures({ revenue: 900_000, costOfSales: 560_000, netProfit: 90_000, cash: 130_000 }),
  priorWindow: { start: '2025-12-01', end: '2025-12-31' },
  budget: null,
};

const setWithoutPrior: PackFigureSet = {
  current: figures({}),
  currentWindow: { start: '2026-01-01', end: '2026-01-31' },
  prior: null,
  priorWindow: { start: '2025-12-01', end: '2025-12-31' },
  budget: null,
};

// Mirrors Brightsphere: negative revenue, so gross margin is not printable.
const negativeRevenueSet: PackFigureSet = {
  current: figures({ revenue: -50_000, costOfSales: 30_000, netProfit: -120_000, totalEquity: -250_000 }),
  currentWindow: { start: '2026-01-01', end: '2026-01-31' },
  prior: null,
  priorWindow: { start: '2025-12-01', end: '2025-12-31' },
  budget: null,
};

describe('buildHighlightTiles', () => {
  it('emits the curated four tiles, never the forty-ratio grid', () => {
    const tiles = buildHighlightTiles(setWithPrior, trend, new PackFigureProvenance());
    expect(tiles).toHaveLength(4);
    expect(tiles.map((t) => t.label)).toEqual(['Revenue', 'Net profit', 'Gross margin', 'Cash']);
  });

  it('states a delta against the prior period when one exists', () => {
    const tiles = buildHighlightTiles(setWithPrior, trend, new PackFigureProvenance());
    const revenue = tiles.find((t) => t.label === 'Revenue');
    expect(revenue?.delta?.basis).toBe('prior period');
    expect(revenue?.delta?.favourable).toBe(true);
  });

  it('omits the delta entirely rather than printing one against a zeroed prior', () => {
    const tiles = buildHighlightTiles(setWithoutPrior, trend, new PackFigureProvenance());
    for (const tile of tiles) expect(tile.delta).toBeNull();
  });

  it('marks gross margin notMeaningful on non-positive revenue rather than printing a false percentage', () => {
    const tiles = buildHighlightTiles(negativeRevenueSet, [], new PackFigureProvenance());
    const grossMargin = tiles.find((t) => t.label === 'Gross margin');
    expect(grossMargin?.figure.value).toBeNull();
    expect(grossMargin?.figure.unavailable).toBeTruthy();
    expect(grossMargin?.delta).toBeNull();
  });

  it('renders a sparkline for revenue and net profit when a monthly series exists', () => {
    const tiles = buildHighlightTiles(setWithPrior, trend, new PackFigureProvenance());
    expect(tiles.find((t) => t.label === 'Revenue')?.sparklineSvg).not.toBeNull();
    expect(tiles.find((t) => t.label === 'Net profit')?.sparklineSvg).not.toBeNull();
  });

  it('carries no sparkline when there is no monthly series', () => {
    const tiles = buildHighlightTiles(setWithPrior, [], new PackFigureProvenance());
    expect(tiles.find((t) => t.label === 'Revenue')?.sparklineSvg).toBeNull();
  });

  it('records provenance for every figure it emits', () => {
    const p = new PackFigureProvenance();
    buildHighlightTiles(setWithPrior, trend, p);
    for (const [source] of p.all()) expect(source).toContain('.');
  });
});
