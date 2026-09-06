import { describe, expect, it } from 'vitest';
import {
  cashTitle,
  highlightsTitle,
  largestMoverCaption,
  positionTitle,
  scorecardCaption,
  scorecardTitle,
  trendsCaption,
} from '@/modules/accounting/services/packs/narrative/derivedSentences';
import type { PackTableRow, PackChartSpec, PackScorecardGroup } from '@/modules/accounting/services/packs/pages/packPageModel';

const set = (revenue: number, priorRevenue: number | null, operatingProfit: number) => ({
  current: { revenue, operatingProfit, totalEquity: 1_000_000, cash: 200_000 },
  prior: priorRevenue === null ? null : { revenue: priorRevenue, operatingProfit: 0, totalEquity: 900_000, cash: 180_000 },
} as never);

describe('highlightsTitle', () => {
  it('states direction and magnitude against the prior period', () => {
    expect(highlightsTitle(set(1_120_000, 1_000_000, 50_000)))
      .toMatch(/Revenue up 12(\.0)?%/);
  });

  it('says so plainly when there is no comparative', () => {
    expect(highlightsTitle(set(1_120_000, null, 50_000)))
      .toMatch(/no comparative period/i);
  });

  it('does not claim a percentage change from a non-positive base', () => {
    // Brightsphere: negative revenue. A percentage against a negative base is
    // arithmetically meaningless and reads as a triumph or a catastrophe at random.
    const title = highlightsTitle(set(-50_000, -100_000, -20_000));
    expect(title).not.toMatch(/%/);
    expect(title).toMatch(/negative|not meaningful/i);
  });

  it('never prints a margin of 0% on non-positive turnover', () => {
    expect(highlightsTitle(set(0, 0, 0))).not.toMatch(/0(\.0)?% margin/);
  });

  it('states the down direction when revenue fell', () => {
    expect(highlightsTitle(set(900_000, 1_000_000, 50_000)))
      .toMatch(/Revenue down 10(\.0)?%/);
  });

  it('prints the margin off OPERATING profit, not net profit (spec §4.A p3)', () => {
    // R-P37: the fixture's `netProfit` is always undefined; only
    // `operatingProfit` is real here, so this pins the branch that a
    // reversion to `netProfit` would silently fall through to null on.
    const title = highlightsTitle(set(1_120_000, 1_000_000, 50_000));
    // 50,000 / 1,120,000 = 4.4642...% -> 4.5% at 1dp.
    expect(title).toMatch(/Operating margin is 4\.5%/);
  });

  it('no-margin fallback names the operating line, not net profit', () => {
    const title = highlightsTitle(set(0, 0, 0));
    expect(title).toMatch(/operating margin/i);
    expect(title).not.toMatch(/net profit margin/i);
  });
});

describe('positionTitle', () => {
  it('names negative equity in the title, per spec §3.5', () => {
    const negative = { current: { totalEquity: -250_000, totalAssets: 1, totalLiabilities: 2 }, prior: null } as never;
    expect(positionTitle(negative)).toMatch(/negative equity/i);
  });

  it('does not call positive equity negative', () => {
    const positive = { current: { totalEquity: 250_000, totalAssets: 1, totalLiabilities: 2 }, prior: null } as never;
    expect(positionTitle(positive)).not.toMatch(/negative equity/i);
  });
});

describe('cashTitle', () => {
  it('states direction against the prior period', () => {
    const s = { current: { cash: 220_000 }, prior: { cash: 200_000 } } as never;
    expect(cashTitle(s)).toMatch(/Cash is up 10(\.0)?%/);
  });

  it('says so plainly when there is no comparative', () => {
    const s = { current: { cash: 220_000 }, prior: null } as never;
    expect(cashTitle(s)).toMatch(/no comparative period/i);
  });

  it('does not claim a percentage change from a non-positive cash base', () => {
    const s = { current: { cash: 220_000 }, prior: { cash: -50_000 } } as never;
    const title = cashTitle(s);
    expect(title).not.toMatch(/%/);
    expect(title).toMatch(/not meaningful/i);
  });
});

describe('scorecardTitle', () => {
  it('reads as a judgement, not a label', () => {
    expect(scorecardTitle(6, 9)).toBe('Scorecard | 6 of 9 targets met');
  });
});

describe('scorecardCaption', () => {
  const row = (status: PackScorecardGroup['rows'][number]['status']) => ({
    metric: 'm',
    actual: { value: 1, format: 'money', source: 'x.y' },
    target: null,
    prior: { value: 1, format: 'money', source: 'x.y' },
    status,
    trend: 'flat',
    trendSvg: null,
    bulletSvg: null,
  });

  it('counts met and missed among scored rows', () => {
    const groups: PackScorecardGroup[] = [
      { letter: 'A', name: 'Growth', rows: [row('met'), row('met'), row('missed')] },
    ];
    expect(scorecardCaption(groups)).toMatch(/2 of 3 scored targets were met/);
    expect(scorecardCaption(groups)).toMatch(/1 missed/);
  });

  it('excludes unscored and notMeaningful rows from the denominator', () => {
    const groups: PackScorecardGroup[] = [
      { letter: 'A', name: 'Growth', rows: [row('met'), row('unscored'), row('notMeaningful')] },
    ];
    expect(scorecardCaption(groups)).toMatch(/1 of 1 scored targets were met/);
  });

  it('says so plainly when nothing has a target', () => {
    const groups: PackScorecardGroup[] = [
      { letter: 'A', name: 'Growth', rows: [row('unscored')] },
    ];
    expect(scorecardCaption(groups)).toMatch(/no scorecard metric/i);
  });
});

describe('largestMoverCaption', () => {
  const line = (label: string, changePct: number | null): PackTableRow => ({
    label,
    level: 0,
    role: 'line',
    figures: {
      changePct: changePct === null
        ? { value: null, format: 'pct', source: 'x.y', unavailable: 'no comparative' }
        : { value: changePct, format: 'pct', source: 'x.y' },
    },
  });

  it('names the row with the largest absolute movement', () => {
    const rows = [line('Revenue', 5), line('Cost of sales', -40), line('Other income', 12)];
    expect(largestMoverCaption(rows)).toMatch(/Cost of sales moved the most, down 40(\.0)?%/);
  });

  it('ignores subtotal rows and rows with no comparative', () => {
    const rows: PackTableRow[] = [
      { label: 'Total', level: 0, role: 'total', figures: { changePct: { value: 90, format: 'pct', source: 'x.y' } } },
      line('Revenue', null),
      line('Rent', 3),
    ];
    expect(largestMoverCaption(rows)).toMatch(/Rent moved the most, up 3(\.0)?%/);
  });

  it('says so plainly when no line has a comparative', () => {
    expect(largestMoverCaption([line('Revenue', null)])).toMatch(/no line item/i);
  });
});

describe('trendsCaption', () => {
  const panel = (id: string, title: string): PackChartSpec => ({
    id, title, kind: 'line', svg: '<svg/>', heightMm: 40,
  });

  it('names the tracked panels', () => {
    const panels = [panel('p1', 'Revenue rose 12%'), panel('p2', 'Cash held flat')];
    expect(trendsCaption(panels)).toMatch(/2 metrics/);
    expect(trendsCaption(panels)).toMatch(/Revenue rose 12%/);
  });

  it('says so plainly when there are no panels', () => {
    expect(trendsCaption([])).toMatch(/no trend panels/i);
  });
});
