/**
 * A FORMULA GIVEN AND ITS INPUTS WITHHELD, AND THE BIGGEST NUMBER ON A SHEET
 * LEFT UNREMARKED ON THAT SHEET.
 *
 * Two things the fourteenth blind gate said stood between this pack and a
 * signature, held here.
 *
 * THE FIRST: debtor days of 213 and creditor days of 789 print on pages 3 and
 * 9, page 12 gives the formula each is taken by, and TRADE RECEIVABLES AND
 * TRADE PAYABLES APPEARED ON NO SHEET OF EITHER PACK. A director could read
 * how the number was made and could not check that it was. The balance sheet
 * carries them now — see `packTradeBalances.ts` — and the arithmetic is
 * reproduced here off the printed figures rather than asserted to exist.
 *
 * THE SECOND: the largest figure on page 5 is a COST OF SALES OF (1 922) on
 * the demo company and a REVENUE OF (5 535) on Brightsphere, and page 5 said
 * nothing about either. The caption names it now, with the reading its sign
 * carries.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { largestContraryFigureSentence } from '@/modules/accounting/services/packs/pages/packMonthlyResults';
import {
  dayCountsMeasured,
  tradeBalancesFootnote,
} from '@/modules/accounting/services/packs/pages/packTradeBalances';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { formatMoney, inProse, MONEY_SCALES } from '@/lib/format/money';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { PackPage } from '@/modules/accounting/services/packs/pages/packPageModel';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import { brightsphereLiveInput, demoInput } from './fixtures/boardPackInputs';
import { liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';

const money = (n: number): string => formatMoney(n, { scale: PACK_SCALE });
/** The figure as a SENTENCE states it — `nil`, never the money column's
 *  dash. Brightsphere carries no trade payable at all. */
const inWords = (n: number): string => inProse(money(n));
const printed = (n: number): number =>
  Math.sign(n) * Math.round(Math.abs(n) / MONEY_SCALES[PACK_SCALE]);

function pageNamed(input: BoardPackInput, navLabel: string): PackPage {
  const page = buildBoardPackPages(input).pages.find((p) => p.navLabel === navLabel);
  expect(page, `no page called ${navLabel}`).toBeDefined();
  return page!;
}

/** Every sentence a page prints, footnotes and disclosure notes included. */
function proseOf(page: PackPage): string {
  const parts = [page.title, ...page.footnotes.map((f) => f.text)];
  for (const block of page.blocks) {
    if (block.kind === 'disclosure') {
      for (const note of block.disclosure.notes) parts.push(`${note.heading} ${note.body}`);
    }
    if (block.kind === 'narrative' && block.narrative.body !== null) parts.push(block.narrative.body);
    if (block.kind === 'definitions') {
      for (const entry of block.entries) parts.push(`${entry.term} ${entry.definition}`);
    }
  }
  return parts.join('\n');
}

const LIVE: Array<[string, BoardPackInput]> = [
  ['the live demo company as it renders', liveDemoRenderedInput],
  ['Brightsphere as the live route composed it', brightsphereLiveInput],
  ['the demo company', demoInput],
];

describe('the balance sheet prints the balances its day counts are taken on', () => {
  for (const [name, input] of LIVE) {
    it(`states trade receivables and trade payables — ${name}`, () => {
      const sheet = pageNamed(input, 'Balance sheet');
      const memo = sheet.footnotes.map((f) => f.text).find((t) => t.startsWith('Memorandum:'));

      expect(memo, 'page 7 carries no trade-balances memorandum').toBeDefined();
      // The figures as the SHEET prints them, not as the model holds them:
      // this is the string a director reads, and it is the only reading the
      // arithmetic below can be taken on.
      expect(memo).toContain(inWords(input.set.current.accountsReceivable));
      expect(memo).toContain(inWords(input.set.current.accountsPayable));
      expect(memo).toContain(`in ${PACK_SCALE}`);
    });
  }

  /**
   * THE POINT OF PRINTING THEM — 213 comes back out.
   *
   * Debtor days is receivables over revenue times 365. Both figures are now
   * on the paper (the receivable in page 7's memorandum, revenue on page 6),
   * so this takes the division the way a director would: on the ROUNDED
   * figures the sheets print, to within the unit the day count prints in.
   * Page 12's rounding note licenses exactly this much drift and no more.
   */
  it('the printed receivable and the printed revenue reproduce the printed debtor days', () => {
    const set = liveDemoRenderedInput.set;
    expect(dayCountsMeasured(set), 'this fixture must be a company that HAS debtor days').toBe('both');

    const row = buildBoardPackPages(liveDemoRenderedInput).pages
      .flatMap((p) => p.blocks)
      .flatMap((b) => (b.kind === 'scorecard' ? b.groups.flatMap((g) => g.rows) : []))
      .find((r) => r.metric === 'Debtor days');
    expect(row?.actual.value, 'the scorecard prints no debtor days').not.toBeNull();
    const days = row!.actual.value!;

    // THE IDENTITY, on the figures the ledger issued. If the memorandum ever
    // prints a receivable the day count is not taken on, this is the
    // assertion that goes red. To a twentieth of a day: `calculateExtendedRatios`
    // rounds the quotient to four places before annualising it, so an honest
    // day count sits a hundredth or two off the raw division and no further.
    expect((set.current.accountsReceivable / set.current.revenue) * 365).toBeCloseTo(days, 1);

    // AND THE DIVISION A DIRECTOR ACTUALLY TAKES, off the two ROUNDED figures
    // the sheets print. The bound is what rounding both inputs to the nearest
    // R'000 can move the quotient by — half a unit each way on each — which
    // is precisely the drift page 12's rounding note licenses and nothing
    // more. It is not a slack tolerance: on the live demo ledger the two
    // agree at 213 days exactly.
    const fromTheSheet = (printed(set.current.accountsReceivable) / printed(set.current.revenue)) * 365;
    const half = MONEY_SCALES[PACK_SCALE] / 2;
    const bound = days * (half / Math.abs(set.current.accountsReceivable) + half / Math.abs(set.current.revenue));
    expect(Math.abs(fromTheSheet - days)).toBeLessThanOrEqual(bound);
  });

  /**
   * A FOOTNOTE MAY NOT NAME A MEASURE THE PAGE IT POINTS AT DOES NOT STATE —
   * the same rule as "a page may not name a chart the pack does not draw".
   *
   * Brightsphere's revenue and cost of sales are not positive bases, so its
   * scorecard prints a reason in place of both day counts. All four arms are
   * exercised, including the two no fixture reaches, which is the whole
   * reason `DAY_COUNT_USE` is a total `Record`.
   */
  const withBases = (revenue: number, costOfSales: number): PackFigureSet => ({
    ...demoInput.set,
    current: { ...demoInput.set.current, revenue, costOfSales },
  });

  const CASES: Array<[string, PackFigureSet, string, string[]]> = [
    ['both measurable', withBases(1_000_000, 400_000), 'both', ['debtor days and creditor days']],
    ['debtor days only', withBases(1_000_000, 0), 'debtorOnly', ['Trade receivables is the numerator']],
    ['creditor days only', withBases(0, 400_000), 'creditorOnly', ['Trade payables is the numerator']],
    ['neither', withBases(0, 0), 'neither', ['states why neither day count can be measured']],
  ];

  for (const [name, set, measured, phrases] of CASES) {
    it(`points only at the day counts the scorecard states — ${name}`, () => {
      expect(dayCountsMeasured(set)).toBe(measured);
      const text = tradeBalancesFootnote(set, PACK_SCALE, 3).text;
      for (const phrase of phrases) expect(text).toContain(phrase);
      // And never at one it does not: the two names are absent unless this
      // arm printed them.
      if (measured !== 'both' && measured !== 'debtorOnly') expect(text).not.toContain('debtor days');
      if (measured !== 'both' && measured !== 'creditorOnly') expect(text).not.toContain('creditor days');
    });
  }
});

describe("page 5 remarks on page 5's largest figure", () => {
  const largestMonthCell = (trend: PackTrendPoint[]): number => Math.max(
    ...trend.flatMap((p) => [
      p.revenue, p.otherIncome, p.costOfSales, p.operatingExpenses,
      p.expenses - p.costOfSales - p.operatingExpenses, p.netProfit,
    ].map(Math.abs)),
  );

  for (const [name, input] of [LIVE[0]!, LIVE[1]!]) {
    it(`names it, with the reading its sign carries — ${name}`, () => {
      const trend = input.trend;
      // NOT VACUOUS: this company's biggest monthly figure must actually be
      // the contrary-signed one the sentence exists for, or the assertion
      // below is about nothing.
      const biggest = largestMonthCell(trend);
      expect(biggest, 'this fixture has no monthly figures').toBeGreaterThan(0);

      const caption = proseOf(pageNamed(input, 'Group results'));
      expect(caption).toContain('The largest figure among the months above is');
      expect(caption).toContain(money(-biggest));
      expect(caption).toContain('more was reversed out of those accounts than was posted into them');
    });
  }

  it('says nothing where the largest figure carries its band\'s ordinary sign', () => {
    const ordinary: PackTrendPoint[] = liveDemoRenderedInput.trend.map((p) => ({
      ...p,
      revenue: Math.abs(p.revenue),
      otherIncome: Math.abs(p.otherIncome),
      costOfSales: Math.abs(p.costOfSales),
      operatingExpenses: Math.abs(p.operatingExpenses),
      expenses: Math.abs(p.costOfSales) + Math.abs(p.operatingExpenses),
    }));
    expect(largestContraryFigureSentence(ordinary, PACK_SCALE)).toBe('');
  });

  it('says nothing where the largest figure is a net profit', () => {
    const profitLed: PackTrendPoint[] = liveDemoRenderedInput.trend.map((p, i) => ({
      ...p,
      revenue: Math.abs(p.revenue),
      otherIncome: Math.abs(p.otherIncome),
      costOfSales: Math.abs(p.costOfSales),
      operatingExpenses: Math.abs(p.operatingExpenses),
      expenses: Math.abs(p.costOfSales) + Math.abs(p.operatingExpenses),
      netProfit: i === 0 ? -9_000_000 : p.netProfit,
    }));
    expect(largestContraryFigureSentence(profitLed, PACK_SCALE)).toBe('');
  });
});

describe('two conventions the pack applied and did not declare', () => {
  it('the scorecard says what its own count excludes, and the exclusion is real', () => {
    const rows = buildBoardPackPages(liveDemoRenderedInput).pages
      .flatMap((p) => p.blocks)
      .flatMap((b) => (b.kind === 'scorecard' ? b.groups.flatMap((g) => g.rows) : []));
    // The condition the clause is about: a target PRINTED on a row the count
    // leaves out. Without one, the sentence describes nothing.
    const printedButUnscored = rows.filter((r) => r.target !== null && r.status === 'notMeaningful');
    expect(printedButUnscored.length, 'no row prints a target it is not scored on').toBeGreaterThan(0);

    expect(proseOf(pageNamed(liveDemoRenderedInput, 'Scorecard')))
      .toContain('A target on a metric the figures cannot support is not counted as scored');
  });

  /**
   * "so their slopes are not comparable with the panels above" pointed BY
   * POSITION on a sheet laid out two panels across in an order the data
   * decides — and the top-right panel has nothing above it, so for that one
   * the caution named nothing at all. The class it means is the panels on the
   * shared scale.
   */
  it('page 10 names the panels it compares against by class, not by position', () => {
    const trends = proseOf(pageNamed(liveDemoRenderedInput, 'Trends'));
    expect(trends, 'this fixture must actually put a panel on its own scale')
      .toContain('are on their OWN scales');
    expect(trends).toContain('not comparable with the shared-scale panels');
    expect(trends).not.toContain('the panels above');
  });

  it('the basis page declares the plus sign, and the pack actually uses it', () => {
    const doc = buildBoardPackPages(liveDemoRenderedInput);
    const figures = [...doc.provenance.all().values()].flat();
    // A positive percentage that prints with a `+`, and a positive money
    // figure that does not — the juxtaposition the convention is about.
    expect(figures.some((f) => f.format === 'pct' && (f.value ?? 0) > 0)).toBe(true);
    expect(figures.some((f) => f.format === 'money' && (f.value ?? 0) > 0)).toBe(true);
    expect(money(1_000_000)).not.toContain('+');

    expect(proseOf(pageNamed(liveDemoRenderedInput, 'Basis of preparation')))
      .toContain('Only a positive change takes a +.');
  });
});
