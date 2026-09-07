import { describe, expect, it } from 'vitest';
import {
  cashTitle,
  highlightsTitle,
  incomeStatementTitle,
  largestMoverCaption,
  positionTitle,
  scorecardCaption,
  scorecardTitle,
  tileCaption,
  trendsCaption,
} from '@/modules/accounting/services/packs/narrative/derivedSentences';
import type {
  PackChartSpec,
  PackKpiTile,
  PackScorecardGroup,
  PackTableRow,
} from '@/modules/accounting/services/packs/pages/packPageModel';

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
    expect(title).toMatch(/Operating margin is a positive 4\.5%/);
  });

  it('no-margin fallback names the operating line, not net profit', () => {
    const title = highlightsTitle(set(0, 0, 0));
    expect(title).toMatch(/operating margin/i);
    expect(title).not.toMatch(/net profit margin/i);
  });
});

/**
 * THE HEADLINE SENTENCES DROPPED THE MINUS SIGN.
 *
 * A rendered pack's sheet 6 read "Gross margin of 1348.0%" in the largest
 * type on the page, directly above its own table reading (1348.0%); sheet 3
 * read "Operating margin is 1564.3%" against (1564.3%). A margin of positive
 * 1348% and one of negative 1348% are not the same claim about a business,
 * and the header is the line that gets read.
 *
 * Both sentences went through `formatPctMagnitude`, which is correct in
 * isolation — an unsigned magnitude, for prose that carries direction in a
 * word — and was reached by two sentences that carry no such word. These
 * exercise a NEGATIVE value through both builders and assert the direction
 * survives into the string.
 */
describe('a negative percentage keeps its direction in the sentence', () => {
  const negativeMargin = () => set(100_000, null, -1_564_300);

  it('says the operating margin is NEGATIVE, not just how large it is', () => {
    const title = highlightsTitle(negativeMargin(), "R'000");
    expect(title).toContain('1564.3%');
    expect(title).toMatch(/negative 1564\.3%/);
    // And the failure the fixture reproduces: the magnitude alone, with the
    // sentence saying "is" and nothing else.
    expect(title).not.toMatch(/margin is 1564\.3%/);
  });

  it('says the gross margin is NEGATIVE on page 6', () => {
    const title = incomeStatementTitle(
      { current: { revenue: 100_000, costOfSales: 1_448_000, operatingExpenses: 226_000 } } as never,
      "R'000",
    );
    expect(title).toMatch(/negative 1348\.0%/);
    expect(title).not.toMatch(/margin of 1348\.0%/);
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
    expect(scorecardTitle(6, 9)).toBe('6 of 9 scored targets were met this period.');
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

  /**
   * Sheet 5 printed "No line item shows a meaningful period-on-period
   * movement" and sheet 6, the next page, printed "Cost of sales moved the
   * most, up 77.8%." Sheet 5's summary carries exactly one `line` row, whose
   * percentage is not meaningful because the comparative is not a positive
   * base — so the page had concluded something about the PERIOD from a missing
   * PERCENTAGE, two sheets from its own counter-example.
   */
  it('says the percentage is missing, not that nothing moved', () => {
    const caption = largestMoverCaption([line('Revenue', null)]);

    expect(caption).toMatch(/no line item on this page/i);
    // The claim it must NOT make: this page cannot see the other page's table.
    expect(caption).not.toMatch(/meaningful period-on-period movement/);
    // And it carries the cells' own reason rather than inventing one.
    expect(caption).toContain('no comparative');
  });

  it('still says something when the column carries no reason either', () => {
    const bare: PackTableRow = { label: 'Revenue', level: 0, role: 'line', figures: {} };
    expect(largestMoverCaption([bare])).toMatch(/no line item on this page/i);
  });
});

describe('trendsCaption', () => {
  const panel = (id: string, title: string): PackChartSpec => ({
    id, title, kind: 'line', svg: '<svg/>', heightMm: 40,
  });

  it('counts the tracked panels without restating their titles', () => {
    const panels = [panel('p1', 'Revenue rose 12%'), panel('p2', 'Cash held flat')];
    expect(trendsCaption(panels)).toMatch(/2 metrics/);
    // Each panel prints its own title three centimetres away; repeating all
    // six here told the reader nothing new and was enough on its own to push
    // the landscape page onto a second sheet.
    expect(trendsCaption(panels)).not.toMatch(/Revenue rose 12%/);
    expect(trendsCaption(panels)).toMatch(/each panel states/);
  });

  it('says so plainly when there are no panels', () => {
    expect(trendsCaption([])).toMatch(/no trend panels/i);
  });
});

describe("a tile's caption, where the tile shows no movement", () => {
  /** A tile with a figure, and whatever the caller says about its delta. */
  const tile = (delta: PackKpiTile['delta'], deltaAbsence: PackKpiTile['deltaAbsence']): PackKpiTile => ({
    label: 'Revenue',
    figure: { source: 'set.current.revenue', value: 99, kind: 'money', unavailable: null },
    delta,
    deltaAbsence,
    trendFootnote: null,
    sparklineSvg: null,
  });

  it('states the reason the tile gives', () => {
    expect(tileCaption(tile(null, 'unusableBase'))).toMatch(/not a positive base/i);
  });

  it('REFUSES a tile that shows no movement and states no reason', () => {
    // `PackKpiTile` says exactly one of `delta` and `deltaAbsence` is
    // non-null, and this used to be spelt `?? 'noCurrentValue'` — a fallback
    // that prints "This tile has no figure for the period, so there is
    // nothing to move" beside a tile that has just printed 99. The state is
    // unreachable from `buildHighlightTiles` today, which is exactly why the
    // invariant needs a gate rather than a default: the next builder is the
    // one that breaks it, and a caption that is false on a board pack is
    // worse than a render that stops.
    expect(() => tileCaption(tile(null, null))).toThrow(/states no reason/);
  });
});
