/**
 * A NEGATIVE DAY COUNT OR A NEGATIVE COVER IS NOT A FIGURE.
 *
 * Velocity Fibre's page 9 printed, in its prior column, debtor days of
 * "(30 days)" and interest cover of "(805.28)×". Neither describes anything:
 * a debtor book collected thirty days before the sale, and a company covering
 * its interest minus eight hundred times. Receivables were a net credit of
 * (1 097) and operating profit a loss of (52 169), so the quotients' signs
 * stopped tracking the story — the rule the highlights page already applies
 * to a base that is not positive. The scorecard now states n/m with the
 * reason, in either column.
 *
 * Each refusal is paired with the case it must still allow, or a read that
 * refused everything would pass.
 */
import { describe, expect, it } from 'vitest';
import { formatFigureText } from '@/components/accounting/packs/primitives/packFigureText';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { buildScorecardGroups } from '@/modules/accounting/services/packs/pages/packScorecard';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import { demoSet, figures } from './fixtures/boardPackInputs';

/** Velocity Fibre's comparative period (1 April – 31 December 2025), as its
 *  page 6 and page 7 printed it. */
const velocityPrior = figures({
  revenue: 13_163_000,
  costOfSales: 51_512_000,
  operatingExpenses: 13_820_000,
  operatingProfit: -52_169_000,
  netProfit: -52_234_000,
  interestExpense: 64_783,
  accountsReceivable: -1_097_000,
  accountsPayable: 9_423_000,
  totalAssets: 6_901_000,
  totalLiabilities: 59_135_000,
  totalEquity: -52_234_000,
  currentAssets: 6_722_000,
  currentLiabilities: 59_135_000,
  cash: 544_000,
});

const set = (prior: PackFigureSet['prior']): PackFigureSet => ({ ...demoSet, prior });

const rowOf = (s: PackFigureSet, metric: string) => buildScorecardGroups(s, new PackFigureProvenance())
  .flatMap((g) => g.rows).find((r) => r.metric === metric)!;

describe('page 9\'s prior column on Velocity Fibre\'s comparative', () => {
  it('states debtor days as n/m with the reason, not (30 days)', () => {
    const prior = rowOf(set(velocityPrior), 'Debtor days').prior!;
    expect(prior.value).toBeNull();
    expect(prior.unavailable).toMatch(/receivables are a net credit/i);
    expect(formatFigureText(prior, PACK_SCALE)).not.toMatch(/\(\d/);
  });

  it('states interest cover as n/m with the reason, not (805.28)×', () => {
    const prior = rowOf(set(velocityPrior), 'Interest cover').prior!;
    expect(prior.value).toBeNull();
    expect(prior.unavailable).toMatch(/operating profit is a loss/i);
  });

  it('states creditor days as n/m where payables are a net debit', () => {
    const prior = rowOf(set(figures({ ...velocityPrior, accountsPayable: -400_000 })), 'Creditor days').prior!;
    expect(prior.value).toBeNull();
    expect(prior.unavailable).toMatch(/payables are a net debit/i);
  });
});

describe('the same reads still state the figures they can', () => {
  it('a positive receivables balance, operating profit and payables print as figures', () => {
    const healthy = figures({ ...velocityPrior, accountsReceivable: 1_097_000, operatingProfit: 52_169_000 });
    const s = set(healthy);
    expect(rowOf(s, 'Debtor days').prior!.value).toBeCloseTo(30.42, 1);
    expect(rowOf(s, 'Interest cover').prior!.value).toBeCloseTo(805.29, 1);
    expect(rowOf(s, 'Creditor days').prior!.value).toBeCloseTo(66.77, 1);
  });

  it('nil receivables are a measured nil day count, not n/m', () => {
    const prior = rowOf(set(figures({ ...velocityPrior, accountsReceivable: 0 })), 'Debtor days').prior!;
    expect(prior.value).toBe(0);
  });

  it('the actual column follows the same rule', () => {
    const current = rowOf({ ...demoSet, current: velocityPrior }, 'Debtor days').actual;
    expect(current.value).toBeNull();
    expect(current.unavailable).toMatch(/receivables are a net credit/i);
  });
});
