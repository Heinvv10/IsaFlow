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
import { comparativeLengthClause } from '@/modules/accounting/services/packs/pages/packPeriodLabel';
import { formatMoney, inProse, MONEY_SCALES } from '@/lib/format/money';
import { formatFigureText } from '@/components/accounting/packs/primitives/packFigureText';
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

    it(`states the comparative balances wherever there is a comparative — ${name}`, () => {
      const memo = pageNamed(input, 'Balance sheet').footnotes
        .map((f) => f.text).find((t) => t.startsWith('Memorandum:'))!;
      const prior = input.set.prior;
      if (prior === null) {
        expect(memo, 'a first-period pack has no comparative to name').not.toContain('comparative period end');
        return;
      }
      expect(memo).toContain('at the comparative period end');
      expect(memo).toContain(inWords(prior.accountsReceivable));
      expect(memo).toContain(inWords(prior.accountsPayable));
    });
  }

  /**
   * THE PRIOR COLUMN'S TURN — 1 035 comes back out.
   *
   * The fifteenth gate found the scorecard's creditor days PRIOR of 1 035 was
   * the one figure in either pack whose numerator appeared on no sheet: the
   * memorandum carried the actual column's balances and stopped there. The
   * same division as the actual column, on the comparative period's own
   * payable and cost of sales, both now printed.
   */
  it('the printed comparative payable reproduces the printed prior creditor days', () => {
    const set = liveDemoRenderedInput.set;
    expect(set.prior, 'this fixture must be a company that HAS a comparative').not.toBeNull();

    const row = buildBoardPackPages(liveDemoRenderedInput).pages
      .flatMap((p) => p.blocks)
      .flatMap((b) => (b.kind === 'scorecard' ? b.groups.flatMap((g) => g.rows) : []))
      .find((r) => r.metric === 'Creditor days');
    expect(row?.prior?.value, 'the scorecard prints no prior creditor days').not.toBeNull();
    const days = row!.prior!.value!;

    expect((set.prior!.accountsPayable / set.prior!.costOfSales) * 365).toBeCloseTo(days, 1);

    // And off the ROUNDED pair a director divides, to the drift page 12's
    // rounding note licenses — half a unit each way on each input.
    const fromTheSheet = (printed(set.prior!.accountsPayable) / printed(set.prior!.costOfSales)) * 365;
    const half = MONEY_SCALES[PACK_SCALE] / 2;
    const bound = days
      * (half / Math.abs(set.prior!.accountsPayable) + half / Math.abs(set.prior!.costOfSales));
    expect(Math.abs(fromTheSheet - days)).toBeLessThanOrEqual(bound);
  });

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
    // The scope clause is part of the claim, not decoration: without it the
    // sentence says the two balances are the numerators of BOTH scorecard
    // columns, which was true of the actual column alone until the
    // comparative pair was printed beside them.
    ['both measurable', withBases(1_000_000, 400_000), 'both',
      ['debtor days and creditor days', 'each column on its own period']],
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
      .toContain('Only a positive value takes a +.');
  });

  /**
   * THE NOUN, HELD TO THE SHEETS THAT DISPROVED THE OLD ONE.
   *
   * "Only a positive CHANGE takes a +" was written to describe a practice it
   * got wrong: page 6's `% of revenue` column and page 9's target both print
   * signed positives and neither is a change. This is that condition, taken
   * off the composed pages rather than off a belief about them — so the day
   * a signed non-change stops printing, the assertion says so instead of
   * quietly licensing the narrower word again.
   */
  it('the pack signs positive percentages that are not changes', () => {
    const doc = buildBoardPackPages(liveDemoRenderedInput);
    const signedNonChange = [...doc.provenance.all().entries()]
      .filter(([source]) => source.includes('pctOfRevenue') || source.includes('target'))
      .flatMap(([source, list]) => list.map((f) => ({ source, f })))
      .filter(({ f }) => f.format === 'pct' && (f.value ?? 0) > 0);

    expect(signedNonChange.length, 'no positive percentage that is not a change').toBeGreaterThan(0);
    for (const { f } of signedNonChange) {
      expect(formatFigureText(f), `${f.source} prints unsigned`).toContain('+');
    }

    const basis = proseOf(pageNamed(liveDemoRenderedInput, 'Basis of preparation'));
    expect(basis, 'the noun is disproved by the figures above').not.toContain('positive change takes');
  });
});

/**
 * TWO THINGS THE PACK KNEW AND DID NOT SAY WHERE THEY WERE READ.
 *
 * None of these failed a criterion in the fifteenth gate. Each is a fact the
 * pack already holds, printed on the sheet the reader meets the number on.
 */
describe('facts stated where the figure is read', () => {
  /**
   * The comparative is EXACTLY as long as the reporting period — 250 days
   * each — which is what makes the prior column and every annualised day
   * count comparable at all, and the pack said so nowhere. It is stated on
   * the statement pages, under the column it qualifies, because page 12's
   * own fact list cannot afford the line (see `statementFootnotes`).
   */
  it('every prior column states its own length against the period\'s', () => {
    for (const [name, input] of [LIVE[0]!, LIVE[1]!]) {
      const carrying = buildBoardPackPages(input).pages
        .filter((p) => p.footnotes.some((f) => f.text.startsWith('The prior column is the period')));
      expect(carrying.length, `${name} prints no prior-column footnote`).toBeGreaterThan(0);
      for (const page of carrying) {
        const note = page.footnotes.find((f) => f.text.startsWith('The prior column is the period'))!;
        expect(note.text, `page ${page.number} states no comparative length`).toContain('250 days');
        expect(note.text).toContain('the same length as the reporting period');
      }
    }

    // NOT A CONSTANT: a comparative of a different length says so instead.
    expect(comparativeLengthClause(
      { start: '2026-01-01', end: '2026-09-07' },
      { start: '2025-07-01', end: '2025-12-31' },
    )).toBe("184 days against the reporting period's 250.");
  });

  /**
   * 213 days against a 30-day target, and a third of that gap is the 365-day
   * multiplier: on the period's own 250 days the same book is 146. Page 12
   * disclosed it; page 9, where a director reads the number beside its
   * target, did not.
   */
  it('the scorecard says its day count is annualised, on the scorecard', () => {
    const scorecard = pageNamed(liveDemoRenderedInput, 'Scorecard');
    const rows = scorecard.blocks
      .flatMap((b) => (b.kind === 'scorecard' ? b.groups.flatMap((g) => g.rows) : []));
    const debtorDays = rows.find((r) => r.metric === 'Debtor days');
    // NOT VACUOUS: the page must actually print the annualised count against
    // a target, or the sentence explains nothing.
    expect(debtorDays?.actual.value, 'no debtor days on the scorecard').not.toBeNull();
    expect(debtorDays?.target, 'no target to read it against').not.toBeNull();

    expect(proseOf(scorecard)).toContain('annualised on 365 days');
    // And it is NOT claimed of a measure that is not annualised: the income
    // statement carries the same footnote for gross margin.
    expect(proseOf(pageNamed(liveDemoRenderedInput, 'Income statement')))
      .not.toContain('annualised on 365 days');
  });
});
