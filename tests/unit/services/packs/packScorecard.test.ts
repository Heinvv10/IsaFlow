import { describe, expect, it } from 'vitest';
import { buildScorecardGroups } from '@/modules/accounting/services/packs/pages/packScorecard';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';

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

const healthySet: PackFigureSet = {
  current: figures({}),
  currentWindow: { start: '2026-01-01', end: '2026-01-31' },
  prior: figures({
    revenue: 900_000,
    costOfSales: 560_000,
    operatingExpenses: 230_000,
    operatingProfit: 110_000,
    netProfit: 90_000,
    totalAssets: 850_000,
    totalLiabilities: 310_000,
    totalEquity: 540_000,
    currentAssets: 380_000,
    currentLiabilities: 210_000,
    cash: 130_000,
    accountsReceivable: 85_000,
    accountsPayable: 62_000,
    inventory: 48_000,
    operatingCashFlow: 100_000,
  }),
  priorWindow: { start: '2025-12-01', end: '2025-12-31' },
  budget: null,
};

// Mirrors Brightsphere: negative revenue, negative equity, no budget.
const negativeEquitySet: PackFigureSet = {
  current: figures({
    revenue: -50_000,
    costOfSales: 30_000,
    operatingExpenses: 40_000,
    operatingProfit: -120_000,
    netProfit: -120_000,
    totalAssets: 200_000,
    totalLiabilities: 450_000,
    totalEquity: -250_000,
    currentAssets: 100_000,
    currentLiabilities: 300_000,
    cash: 20_000,
    accountsReceivable: 10_000,
    accountsPayable: 80_000,
    inventory: 5_000,
    operatingCashFlow: undefined,
    capitalExpenditure: undefined,
  }),
  currentWindow: { start: '2026-01-01', end: '2026-01-31' },
  prior: null,
  priorWindow: { start: '2025-12-01', end: '2025-12-31' },
  budget: null,
};

// Otherwise healthy, but the chart of accounts classifies no inventory at
// all — `inventory: 0` is an artefact of nothing being identified as stock,
// not a fact about the business (R-P45).
const unclassifiedInventorySet: PackFigureSet = {
  current: figures({ inventory: 0, inventoryCaveat: 'No accounts are classified as inventory.' }),
  currentWindow: { start: '2026-01-01', end: '2026-01-31' },
  prior: null,
  priorWindow: { start: '2025-12-01', end: '2025-12-31' },
  budget: null,
};

describe('buildScorecardGroups', () => {
  it('emits between 8 and 10 metrics, never the forty-ratio grid', () => {
    const groups = buildScorecardGroups(healthySet, new PackFigureProvenance());
    const rows = groups.flatMap((g) => g.rows);
    expect(rows.length).toBeGreaterThanOrEqual(8);
    expect(rows.length).toBeLessThanOrEqual(10);
  });

  it('groups them A–E by theme with at most five rows in a group', () => {
    const groups = buildScorecardGroups(healthySet, new PackFigureProvenance());
    expect(groups.map((g) => g.letter)).toEqual(['A', 'B', 'C', 'D', 'E']);
    for (const g of groups) expect(g.rows.length).toBeLessThanOrEqual(5);
  });

  // The brief's own verbatim assertion named "return on equity", a ratio
  // NOT in the curated ten (spec §4.A page 9 lists debt-to-equity, not ROE,
  // as group D's equity-basis metric). Corrected to the metric actually on
  // this scorecard that the rule protects — see task-15-report.md.
  it('marks a ratio on non-positive equity notMeaningful rather than printing it', () => {
    const groups = buildScorecardGroups(negativeEquitySet, new PackFigureProvenance());
    const dte = groups.flatMap((g) => g.rows).find((r) => r.metric.match(/debt-to-equity/i));
    expect(dte?.status).toBe('notMeaningful');
    expect(dte?.actual.value).toBeNull();
  });

  it('records provenance for every figure it emits', () => {
    const p = new PackFigureProvenance();
    const groups = buildScorecardGroups(healthySet, p);
    const rowCount = groups.flatMap((g) => g.rows).length;
    // Every actual AND every prior figure must be recorded — an empty `p.all()`
    // would vacuously satisfy a loop-only assertion, so the count is checked.
    const recordedCount = [...p.all().values()].reduce((n, list) => n + list.length, 0);
    expect(recordedCount).toBe(rowCount * 2);
    for (const [source] of p.all()) expect(source).toContain('.');
  });

  it('marks a margin on non-positive revenue notMeaningful rather than printing a false percentage', () => {
    const groups = buildScorecardGroups(negativeEquitySet, new PackFigureProvenance());
    const gm = groups.flatMap((g) => g.rows).find((r) => r.metric.match(/gross margin/i));
    expect(gm?.status).toBe('notMeaningful');
    expect(gm?.actual.value).toBeNull();
  });

  it('scores a metric with no target as unscored, never a fabricated target', () => {
    const groups = buildScorecardGroups(healthySet, new PackFigureProvenance());
    const cashRatio = groups.flatMap((g) => g.rows).find((r) => r.metric.match(/cash ratio/i));
    expect(cashRatio?.target).toBeNull();
    expect(cashRatio?.status).toBe('unscored');
  });

  it('carries a null prior only when there is no prior period at all', () => {
    const groups = buildScorecardGroups(negativeEquitySet, new PackFigureProvenance());
    for (const row of groups.flatMap((g) => g.rows)) expect(row.prior).toBeNull();
  });

  it('carries a real prior figure for every row when a prior period exists', () => {
    const groups = buildScorecardGroups(healthySet, new PackFigureProvenance());
    for (const row of groups.flatMap((g) => g.rows)) expect(row.prior).not.toBeNull();
  });

  // R-P44: the pack figure set carries no interest-expense field at all, so
  // `calculateExtendedRatios.interestCoverage`'s zero-branch would ALWAYS
  // fire here — printing "0x" on every company, which reads as "cannot
  // service its debt from earnings" rather than "we don't capture this".
  it('marks interest cover notMeaningful rather than printing the artefact zero the service always returns', () => {
    const groups = buildScorecardGroups(healthySet, new PackFigureProvenance());
    const interestCover = groups.flatMap((g) => g.rows).find((r) => r.metric.match(/interest cover/i));
    expect(interestCover?.status).toBe('notMeaningful');
    expect(interestCover?.actual.value).toBeNull();
    expect(interestCover?.actual.unavailable).toBeTruthy();
  });

  // R-P45.
  it('marks cash conversion cycle notMeaningful when no inventory could be identified in the chart of accounts', () => {
    const groups = buildScorecardGroups(unclassifiedInventorySet, new PackFigureProvenance());
    const ccc = groups.flatMap((g) => g.rows).find((r) => r.metric.match(/cash conversion cycle/i));
    expect(ccc?.status).toBe('notMeaningful');
    expect(ccc?.actual.value).toBeNull();
    expect(ccc?.actual.unavailable).toBeTruthy();
  });

  // The negative case: without the pin below, an implementation that always
  // reports cash conversion cycle as notMeaningful would still pass every
  // other test in this file — the same unreachable-branch trap as before.
  it('still scores a real cash conversion cycle when inventory carries no caveat', () => {
    const groups = buildScorecardGroups(healthySet, new PackFigureProvenance());
    const ccc = groups.flatMap((g) => g.rows).find((r) => r.metric.match(/cash conversion cycle/i));
    expect(ccc?.status).not.toBe('notMeaningful');
    expect(ccc?.actual.value).not.toBeNull();
  });
});
