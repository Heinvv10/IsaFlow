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

/** `setWithPrior` with the prior period overridden — the prior is what these
 *  polarity fixtures need to move. */
function withPrior(overrides: Partial<ReportPackFigures>): PackFigureSet {
  return { ...setWithPrior, prior: figures({ revenue: 900_000, costOfSales: 560_000, netProfit: 90_000, cash: 130_000, ...overrides }) };
}

describe('buildHighlightTiles', () => {
  // Spec §4.A page 3 names eight tiles, in this order. The original four were
  // half the page: the model built a highlights strip the composer could not
  // fill page 3 with. Still curated — eight chosen figures, never the
  // forty-ratio grid `calculateExtendedRatios` can produce.
  it('emits the curated eight tiles, never the forty-ratio grid', () => {
    const tiles = buildHighlightTiles(setWithPrior, trend, new PackFigureProvenance());
    expect(tiles).toHaveLength(8);
    expect(tiles.map((t) => t.label)).toEqual([
      'Revenue', 'Gross margin', 'Operating profit', 'Net profit',
      'Cash', 'Debt-to-equity', 'Debtor days', 'Working capital',
    ]);
  });

  // A rising debtor book and rising gearing are WORSE periods. Marking either
  // favourable because the percentage is positive flatters the reading in the
  // one direction a board would not question.
  //
  // Both metrics are moved in BOTH directions here on purpose. An earlier
  // version of this test ran against `setWithPrior`, whose prior override
  // leaves liabilities, equity and receivables untouched — so debt-to-equity's
  // delta was exactly zero and that half of the assertion could not fail.
  const gearingRose = withPrior({ totalLiabilities: 200_000, totalEquity: 700_000, accountsReceivable: 60_000 });
  const gearingFell = withPrior({ totalLiabilities: 500_000, totalEquity: 400_000, accountsReceivable: 150_000 });

  it('marks a RISE in debtor days and gearing unfavourable', () => {
    const tiles = buildHighlightTiles(gearingRose, trend, new PackFigureProvenance());
    for (const label of ['Debtor days', 'Debt-to-equity']) {
      const delta = tiles.find((t) => t.label === label)?.delta;
      expect(delta, label).not.toBeNull();
      expect(delta!.value, label).toBeGreaterThan(0);
      expect(delta!.favourable, label).toBe(false);
    }
  });

  it('marks a FALL in debtor days and gearing favourable', () => {
    const tiles = buildHighlightTiles(gearingFell, trend, new PackFigureProvenance());
    for (const label of ['Debtor days', 'Debt-to-equity']) {
      const delta = tiles.find((t) => t.label === label)?.delta;
      expect(delta, label).not.toBeNull();
      expect(delta!.value, label).toBeLessThan(0);
      expect(delta!.favourable, label).toBe(true);
    }
  });

  // Revenue is the control: it is not lower-is-better, so the same rise that
  // is unfavourable above must stay favourable here. Without it, a mutant that
  // simply inverted every tile's polarity would pass both tests above.
  it('leaves a rise in revenue favourable', () => {
    const tiles = buildHighlightTiles(gearingRose, trend, new PackFigureProvenance());
    const delta = tiles.find((t) => t.label === 'Revenue')?.delta;
    expect(delta!.value).toBeGreaterThan(0);
    expect(delta!.favourable).toBe(true);
  });

  // Brightsphere reaches this: `debtorDays` is receivables over revenue, and a
  // net-debit revenue printed "−4 days" — a debtor book collected before the
  // sale. Nothing inspected a tile VALUE, which is why it shipped.
  it('marks debtor days notMeaningful on non-positive revenue rather than printing a negative day count', () => {
    const tiles = buildHighlightTiles(negativeRevenueSet, [], new PackFigureProvenance());
    const debtorDays = tiles.find((t) => t.label === 'Debtor days');
    expect(debtorDays?.figure.value).toBeNull();
    expect(debtorDays?.figure.unavailable).toMatch(/revenue is not positive/i);
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
