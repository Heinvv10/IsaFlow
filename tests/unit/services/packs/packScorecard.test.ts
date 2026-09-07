import { describe, expect, it } from 'vitest';
import { buildScorecardGroups } from '@/modules/accounting/services/packs/pages/packScorecard';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { demoInput } from './fixtures/boardPackInputs';

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

/**
 * A REASON QUALIFIED BY ITS PERIOD, AND THE PAGE THAT COULD NOT FIT TWO OF IT.
 *
 * `PRIOR_PERIOD_PREFIX` exists because a reason computed for the comparative
 * column printed in the unqualified present tense under a current-period
 * figure. Prefixing every prior reason fixed that and created a second one:
 * `NotMeaningfulNotes` prints one note per DISTINCT sentence, so a reason true
 * of both periods became two notes saying the same thing. Brightsphere — whose
 * revenue is negative in both periods — grew its scorecard to 264.9mm on a
 * 255mm sheet and `fitPageToBox` refused the entire pack.
 */
describe('a not-meaningful reason and the period it is about', () => {
  const bothPeriodsNegative: PackFigureSet = {
    current: figures({ revenue: -100_000, costOfSales: 0, operatingCashFlow: 0 }),
    currentWindow: { start: '2026-01-01', end: '2026-01-31' },
    prior: figures({ revenue: -80_000, costOfSales: 0, operatingCashFlow: 0 }),
    priorWindow: { start: '2025-01-01', end: '2025-01-31' },
    budget: null,
  };

  const priorOnly: PackFigureSet = {
    current: figures({}),
    currentWindow: { start: '2026-01-01', end: '2026-01-31' },
    prior: figures({ revenue: -80_000 }),
    priorWindow: { start: '2025-01-01', end: '2025-01-31' },
    budget: null,
  };

  function reasons(set: PackFigureSet): string[] {
    const groups = buildScorecardGroups(set, new PackFigureProvenance());
    const figuresOnPage = groups.flatMap((g) => g.rows.flatMap((r) => [r.actual, r.prior]));
    return [...new Set(
      figuresOnPage
        .filter((f): f is NonNullable<typeof f> => f !== null && f.value === null)
        .map((f) => f.unavailable ?? ''),
    )];
  }

  it('states a reason once when it is true of both periods', () => {
    const stated = reasons(bothPeriodsNegative);
    // The sentence is in the present tense and both periods are in it, so
    // nothing needs qualifying — and the page carries one note, not two.
    expect(stated.filter((r) => r.startsWith('In the comparative period'))).toEqual([]);
    expect(new Set(stated).size).toBe(stated.length);
  });

  it('still says which period a reason that is only true of the comparative is about', () => {
    const stated = reasons(priorOnly);
    const qualified = stated.filter((r) => r.startsWith('In the comparative period'));

    // The defect the prefix was added for: revenue is positive NOW, so a bare
    // "Revenue is not positive…" under this page would be false of the column
    // the reader is looking at.
    expect(qualified.length).toBeGreaterThan(0);
    for (const reason of qualified) {
      expect(stated).not.toContain(reason.slice('In the comparative period: '.length));
    }
  });
});

/**
 * THE SCORECARD'S SCORING RULE — THE TWO ARMS NOTHING IN THIS FILE ASSERTED.
 *
 * `statusFor` has four arms. `notMeaningful` and `unscored` were covered
 * thoroughly above; `met` and `missed` were not covered at all — there was no
 * `toBe('met')` or `toBe('missed')` anywhere in 246 lines. Two mutations
 * proved the gap: inverting `lowerIsBetter` left all 13 tests green, and
 * making every scored metric report `met` — a scorecard on which nothing can
 * ever be missed — left 626 of 627 green across the packs and print suites,
 * the single failure being an unrelated derived headline.
 *
 * A scorecard reporting every missed target as met is the worst thing this
 * page can print: it is the page a board reads to know whether the business
 * is where it said it would be.
 *
 * SO THE POLARITY IS DECLARED HERE, as a fact about the measure rather than a
 * copy of the production flag. Reading `spec.lowerIsBetter` back out of the
 * module under test would score the code against itself, which is what an
 * inverted flag needs the test NOT to do.
 */
const LOWER_IS_BETTER: Record<string, boolean> = {
  'Gross margin': false,
  'Current ratio': false,
  'Debtor days': true,
  'Debt-to-equity': true,
};

/** The four cells the rule has: each polarity, on each side of its target. */
type Cell = 'higher/met' | 'higher/missed' | 'lower/met' | 'lower/missed';

function scoredRows(set: PackFigureSet) {
  return buildScorecardGroups(set, new PackFigureProvenance())
    .flatMap((g) => g.rows)
    .filter((r) => r.target !== null && r.actual.value !== null);
}

describe('the scorecard scores against its target, in both directions', () => {
  const covered = new Set<Cell>();

  /** Comfortably past every target: 40% gross margin against 35, 18.3 debtor
   *  days against 30, debt-to-equity 0.5 against 0.5 on the boundary. */
  const meeting: PackFigureSet = {
    ...healthySet,
    current: figures({ accountsReceivable: 50_000, totalLiabilities: 200_000, totalEquity: 700_000 }),
  };
  /** The same company, every one of those measures the wrong side of its
   *  target: 25% gross margin, 73 debtor days, debt-to-equity 1.5. */
  const missing: PackFigureSet = {
    ...healthySet,
    current: figures({
      costOfSales: 750_000,
      accountsReceivable: 200_000,
      totalLiabilities: 540_000,
      totalEquity: 360_000,
      currentAssets: 150_000,
    }),
  };

  for (const [name, set] of [['meeting its targets', meeting], ['missing them', missing]] as const) {
    it(`says met or missed by comparing the figure with the target — ${name}`, () => {
      const rows = scoredRows(set);
      expect(rows.length, 'no metric on this fixture is scored at all').toBeGreaterThan(2);
      for (const row of rows) {
        const lower = LOWER_IS_BETTER[row.metric];
        if (lower === undefined) continue;
        const value = row.actual.value!;
        const met = lower ? value <= row.target! : value >= row.target!;
        expect(row.status, `${row.metric} reads ${value} against a target of ${row.target} `
          + `(${lower ? 'lower' : 'higher'} is better) and the page says ${row.status}`)
          .toBe(met ? 'met' : 'missed');
        covered.add(`${lower ? 'lower' : 'higher'}/${met ? 'met' : 'missed'}` as Cell);
      }
    });
  }

  /**
   * AND ALL FOUR CELLS WERE REACHED. Two fixtures that both happen to miss
   * every lower-is-better metric would satisfy the assertions above while
   * proving nothing about the polarity, which is the mutation that survived.
   */
  it('reached both polarities on both sides of the target', () => {
    expect([...covered].sort()).toEqual(
      ['higher/met', 'higher/missed', 'lower/met', 'lower/missed'],
    );
  });

  /**
   * AND THE PAGE A DIRECTOR RECEIVES CARRIES THE SAME WORD. The rows above
   * come from the builder; this is the composed document, so a page that
   * assembled its scorecard from anything else would print a status the
   * figure beside it does not support.
   */
  it('prints that word on sheet 9 of the composed pack', () => {
    const page = buildBoardPackPages(demoInput).pages.find((p) => p.navLabel === 'Scorecard')!;
    const block = page.blocks.find((b) => b.kind === 'scorecard');
    const rows = block?.kind === 'scorecard'
      ? block.groups.flatMap((g) => g.rows).filter((r) => r.target !== null && r.actual.value !== null)
      : [];
    expect(rows.length, 'sheet 9 scores nothing on this pack').toBeGreaterThan(2);
    let checked = 0;
    for (const row of rows) {
      const lower = LOWER_IS_BETTER[row.metric];
      if (lower === undefined) continue;
      const value = row.actual.value!;
      const met = lower ? value <= row.target! : value >= row.target!;
      expect(row.status, `sheet 9 prints ${row.status} for ${row.metric} at ${value} against `
        + `${row.target}`).toBe(met ? 'met' : 'missed');
      checked += 1;
    }
    expect(checked, 'no metric with a declared polarity is scored on sheet 9').toBeGreaterThan(1);
  });
});
