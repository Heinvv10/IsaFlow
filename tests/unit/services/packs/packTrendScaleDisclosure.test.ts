/**
 * PAGE 10 ASKS TO BE TRUSTED ON AN ARITHMETIC CLAIM; THESE HOLD IT TO SHOWING
 * ITS WORKING.
 *
 * Two panels stated "1.1% of the shared range" and "1.7%" against a shared
 * scale the page defined in prose — and NO PANEL PRINTED A SINGLE AXIS VALUE,
 * so neither claim could be checked from the sheet: each panel's title gives
 * only its first and last month, and both series visibly peak above their last
 * value. Meanwhile gross margin ran from (4267.6%) to 100.0% and debtor days
 * from 0.0 to 60.5 on a page whose stated shared scale is in R'000, and
 * neither carried the "Own scale" note the two rescaled money panels carried,
 * so silence read as membership: four scales presented as one plus two
 * exceptions.
 *
 * Both halves are structural, so both are asserted structurally — the axis
 * ends off the painted SVG, the disclosure off the panel titles.
 */
import { describe, expect, it } from 'vitest';
import { buildTrendPanels } from '@/modules/accounting/services/packs/pages/packTrendCharts';
import { formatDays, formatMoney, formatPctLevel } from '@/lib/format/money';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { liveDemoRenderedInput, liveDemoTrend } from './fixtures/liveDemoBoardPack';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { demoInput } from './fixtures/boardPackInputs';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

/** Every `<text>` the panel paints — the axis ends among them. */
function painted(svg: string): string[] {
  return [...svg.matchAll(/>([^<>]+)<\/text>/g)].map((m) => m[1]!);
}

/**
 * A trend with positive revenue in every month, so gross margin and debtor
 * days are drawable — the live demo company has neither, which is why its
 * render never exercised the ratio panels' own labelling.
 */
const withRatios: PackTrendPoint[] = liveDemoTrend.map((point, i) => ({
  ...point,
  revenue: 100_000 + i * 10_000,
  grossMarginPct: 40 + i,
  debtorDays: 30 + i * 2,
}));

/**
 * A TREND WHOSE ROUNDED AND UNROUNDED ARITHMETIC DISAGREE, which is the only
 * kind of month series that can tell the two apart.
 *
 * Operating expenses run to 58 400 against a shared domain of (1 621 400) to
 * 1 908 400. On the raw rands that is 1.654% — printed 1.7%. On the figures
 * the sheet actually prints, 58 over a span of 3 529, it is 1.6%. The live
 * demo trend rounds the same either way, which is why it could not see this.
 */
const roundingSplit: PackTrendPoint[] = liveDemoTrend.map((point, i) => ({
  ...point,
  revenue: 0,
  operatingExpenses: i === 6 ? 58_400 : 4_000 + i * 100,
  netProfit: i === 6 ? 1_908_400 : -100_000 - i * 1_000,
  cash: i === 11 ? -1_621_400 : -200_000 - i * 5_000,
}));

describe('page 10 prints the scale its claims are made against', () => {
  it('labels both ends of every panel\'s own domain', () => {
    const { panels } = buildTrendPanels(withRatios, PACK_SCALE);
    expect(panels.length).toBeGreaterThan(0);
    for (const panel of panels) {
      const texts = painted(panel.svg);
      // Two month labels, the end label, and the two axis ends. Fewer than
      // four means an axis painted nothing.
      expect(texts.length, panel.id).toBeGreaterThanOrEqual(4);
    }
  });

  it('prints the shared domain\'s own low and high on every panel that is on it', () => {
    const { panels, sharedScale } = buildTrendPanels(withRatios, PACK_SCALE);
    expect(sharedScale.length).toBeGreaterThan(1);
    const shared = panels.filter((p) => p.sharedScale === true);
    expect(shared.length).toBe(sharedScale.length);
    // The money domain, computed here from the same four series the page
    // draws — zero always inside it, as `domainOf` puts it.
    const money = [
      withRatios.map((p) => p.revenue),
      withRatios.map((p) => p.operatingExpenses),
      withRatios.map((p) => p.netProfit),
      withRatios.map((p) => p.cash),
    ].flat();
    const low = formatMoney(Math.min(0, ...money), { scale: PACK_SCALE });
    const high = formatMoney(Math.max(0, ...money), { scale: PACK_SCALE });
    for (const panel of shared) {
      const texts = painted(panel.svg);
      expect(texts, `${panel.id} does not paint the shared domain's low`).toContain(low);
      expect(texts, `${panel.id} does not paint the shared domain's high`).toContain(high);
    }
  });

  it('marks every panel that is not on the shared scale, in its own title', () => {
    const { panels } = buildTrendPanels(withRatios, PACK_SCALE);
    for (const panel of panels) {
      if (panel.sharedScale === true) {
        expect(panel.title, panel.id).not.toContain('Own scale');
        continue;
      }
      expect(panel.title, panel.id).toContain('Own scale');
    }
  });

  it('gives the ratio panels the reason that is true of them — a different unit', () => {
    const { panels, ownUnits } = buildTrendPanels(withRatios, PACK_SCALE);
    expect(ownUnits).toEqual(['Gross margin', 'Debtor days']);
    const margin = panels.find((p) => p.id === 'trend-gross-margin')!;
    const days = panels.find((p) => p.id === 'trend-debtor-days')!;
    expect(margin.title).toContain(`Own scale: a percentage, not ${PACK_SCALE}.`);
    expect(days.title).toContain(`Own scale: a day count, not ${PACK_SCALE}.`);
    // And their axes are labelled in their OWN unit, not as money.
    expect(painted(margin.svg).some((t) => t === formatPctLevel(0) || t.endsWith('%'))).toBe(true);
    expect(painted(days.svg).some((t) => t.includes('days') || t === formatDays(0, 1))).toBe(true);
  });

  it('never says "of the shared range" without saying it is off that range', () => {
    const { panels } = buildTrendPanels(withRatios, PACK_SCALE);
    for (const panel of panels) {
      if (!panel.title.includes('% of the shared')) continue;
      expect(panel.title, `${panel.id} quotes a share of a scale it does not say it is off`)
        .toContain('Own scale');
    }
  });

  /**
   * THE CHECK THE PAGE INVITES, DONE THE WAY A READER WOULD DO IT.
   *
   * Page 10 says "Every panel labels the low and high of its own axis, so a
   * share of the range can be checked off the sheet." A reviewer did exactly
   * that on the live pack: operating expenses printed an axis of 58 and –
   * against a stated shared span of 3 528, divided them, got 1.6%, and read
   * 1.7% on the panel. Neither figure was wrong — the shares were computed on
   * unrounded rands — but the page dared the reader to check it and the check
   * did not reproduce.
   *
   * So this takes the four numbers off the SHEET, not out of the model: the
   * two axis labels the panel paints and the span the note states. Nothing
   * here recomputes the share the way the source does, so a share derived
   * from raw values again fails it.
   */
  it('reproduces every printed share from the figures the sheet prints', () => {
    const { panels, sharedRange } = buildTrendPanels(roundingSplit, PACK_SCALE);
    const span = Number(/a span of ([\d\u2009 ]+)/.exec(sharedRange!)![1]!.replace(/[^\d]/g, ''));
    expect(span).toBeGreaterThan(0);

    // AND THE SPAN IS THE DIFFERENCE OF THE TWO EXTREMES THE SAME SENTENCE
    // STATES. Rounded separately it is not: the live page published "1 908",
    // "(1 621)" and "a span of 3 528", three figures a reader cannot make
    // agree with a subtraction.
    const ends = /^(.*) to (.*), a span of/.exec(sharedRange!)!;
    const asNumber = (t: string): number => {
      const digits = Number(t.replace(/[^\d]/g, ''));
      return t.startsWith('(') ? -digits : digits;
    };
    expect(asNumber(ends[2]!) - asNumber(ends[1]!), 'the stated span is not the stated range')
      .toBe(span);

    const quoted = panels.filter((p) => /% of the shared one/.test(p.title));
    expect(quoted.length, 'no panel quotes a share, so nothing was checked').toBeGreaterThan(0);
    for (const panel of quoted) {
      const claimed = Number(/its range is ([\d.]+)% of the shared one/.exec(panel.title)![1]!);
      // The axis ends, as painted. A money panel paints its two domain ends,
      // its end label and its two month labels; the ends are the numeric ones
      // that are not the end label's value.
      const numbers = painted(panel.svg)
        .map((t) => t.replace(/\u2009| /g, ''))
        .filter((t) => /^\(?[\d]+\)?$|^\u2013$/.test(t))
        .map((t) => (t === '\u2013' ? 0 : Number(t.replace(/[()]/g, '')) * (t.startsWith('(') ? -1 : 1)));
      expect(numbers.length, `${panel.id} paints no axis ends`).toBeGreaterThanOrEqual(2);
      const own = Math.max(...numbers) - Math.min(...numbers);
      expect(Math.round((own / span) * 1000) / 10, `${panel.id}: the sheet's own arithmetic`)
        .toBe(claimed);
    }
  });

  it('states the shared range in the same scale the panels paint', () => {
    const { sharedRange } = buildTrendPanels(withRatios, PACK_SCALE);
    expect(sharedRange).not.toBeNull();
    expect(sharedRange!).toContain(PACK_SCALE);
    expect(sharedRange!).not.toMatch(/\d{7}/);
    expect(formatMoney(0, { scale: PACK_SCALE })).toBeTruthy();
  });
});

/**
 * AND THE SENTENCE AGREES WITH ITS OWN SUBJECT.
 *
 * The live demo pack printed "Net profit and Cash share one y-scale, so none
 * of them can look like it moved more than it did." — "none" of two, on a
 * sheet a board reads. The count is derived, so the pronoun is too.
 */
describe('the Scale note counts the panels it is about', () => {
  const noteOf = (input: BoardPackInput): string => {
    const trends = buildBoardPackPages(input).pages.find((p) => p.navLabel === 'Trends')!;
    return trends.blocks
      .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes.map((n) => n.body) : []))
      .join(' ');
  };

  it('says "neither of them" where two panels share the scale', () => {
    const text = noteOf(liveDemoRenderedInput);
    expect(text).toMatch(/share one y-scale/);
    expect(text).toMatch(/neither of them can look like it moved/);
    expect(text).not.toMatch(/none of them can look like it moved/);
  });

  it('says "none of them" where more than two do', () => {
    const text = noteOf(demoInput);
    expect(text).toMatch(/none of them can look like it moved/);
  });
});
