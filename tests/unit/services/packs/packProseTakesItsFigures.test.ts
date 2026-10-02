/**
 * THE THREE THINGS THE PROSE LAYER GOT WRONG, HELD ON THE COMPOSED DOCUMENT.
 *
 * Every one of these was found by PROBING the composer rather than by reading
 * it, and every one was true on the demo fixture and false — or fatal — on a
 * shape no fixture carried. So the assertions here compose real documents
 * against inputs the fixtures do not otherwise reach:
 *
 *  - a figure of NIL in a title, which refuses the whole pack (a 422, not a
 *    dash on paper);
 *  - the income-statement bridge explaining itself as a cash flow statement;
 *  - the credit-month sentence asserting a comparison it never took.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import {
  brightsphereLiveInput,
  demoInput,
  demoSet,
  figures,
  trendEndingAt,
} from './fixtures/boardPackInputs';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';

/**
 * A NIL FIGURE IS AN ORDINARY COMPANY, NOT AN EDGE.
 *
 * `formatMoney` prints a measured zero as an en dash — right in a money
 * column, not a word in a sentence — and `packProseIntegrity`'s zero-glyph
 * rule reads `page.title`, chart titles and derived commentary, with
 * `assertPackIntegrity` THROWING on a hit. Eight prose builders interpolated
 * `formatMoney` raw, so nil net profit, nil cash or current assets equal to
 * current liabilities produced NO PACK AT ALL for that company. Reachability
 * is ordinary — a dormant company, a bank account exactly drawn down — and
 * because the dash covers anything under half a unit of the scale, any of
 * those under five rand at `R'000`.
 *
 * The fixtures were two healthy companies and one broken one; nil is the
 * shape none of them models. This is that shape, one figure at a time. Drop
 * `inProse` from any of the sites in `derivedSentences.ts`,
 * `derivedCaptions.ts` or `packPageCharts.ts` and the matching case here goes
 * red with the refusal message naming the page.
 */
describe('a figure of nil composes a pack rather than refusing one', () => {
  const withCurrent = (overrides: Partial<ReportPackFigures>) => ({
    ...demoInput,
    set: { ...demoSet, current: figures(overrides) },
  });

  const cases: Array<[string, Parameters<typeof buildBoardPackPages>[0]]> = [
    ['net profit is nil', withCurrent({ netProfit: 0 })],
    // The cash TREND has to end where the table closes, or the page states
    // one quantity twice — see `trendEndingAt`. Nil cash means a nil-ending
    // series.
    ['cash is nil', { ...withCurrent({ cash: 0 }), trend: trendEndingAt(0) }],
    // Under R5 at R'000 the dash covers a REAL amount, which is the same
    // refusal from a company that is not dormant at all.
    ['cash is four rand', { ...withCurrent({ cash: 4 }), trend: trendEndingAt(4) }],
    ['working capital is nil', withCurrent({ currentAssets: 940_000 })],
    ['revenue is nil', withCurrent({ revenue: 0 })],
    ['equity is nil', withCurrent({ totalEquity: 0, totalLiabilities: 3_900_000 })],
  ];

  for (const [name, input] of cases) {
    it(`composes twelve sheets where ${name}`, () => {
      let doc: PackPagesDocument | null = null;
      expect(() => { doc = buildBoardPackPages(input); }).not.toThrow();
      expect(doc!.pages).toHaveLength(12);
    });
  }

  it('says the word rather than printing the glyph', () => {
    const doc = buildBoardPackPages(withCurrent({ netProfit: 0 }));
    const narrative = doc.pages.find((p) => p.navLabel === 'Income statement')!;
    const titles = [narrative.title, ...narrative.blocks.flatMap(
      (b) => (b.kind === 'chart' ? [b.chart.title] : []),
    )];
    expect(titles.join(' ')).toContain('nil');
  });
});

/**
 * ONE SENTENCE SERVED TWO BRIDGES AND WAS WRITTEN FOR ONE OF THEM.
 *
 * `disproportionatePlugSentence` told a director that an INCOME STATEMENT
 * bridge's unexplained step "holds everything the operating, investing and
 * financing splits a cash flow statement is made of" and to go and ask for
 * the cash flow statement — about a bridge whose plug is interest and tax.
 * The reason now travels on the bar (`PackWaterfallBar.uncaptured` is a
 * `PlugReason`, not a boolean), so the two bridges cannot share an
 * explanation. Collapse `PLUG_REASON` to one entry and this goes red.
 */
describe('each bridge explains its own plug', () => {
  const plugNote = (doc: PackPagesDocument, navLabel: string): string | null => {
    const page = doc.pages.find((p) => p.navLabel === navLabel)!;
    const block = page.blocks.find(
      (b) => b.kind === 'disclosure' && /unexplained/i.test(b.disclosure.heading),
    );
    return block === undefined || block.kind !== 'disclosure'
      ? null
      : block.disclosure.notes.map((n) => n.body).join(' ');
  };

  it('does not explain the income statement as a cash flow statement', () => {
    // The demo set with an inflated net profit is what makes page 6's plug
    // disproportionate — the same probe the blind review used.
    const doc = buildBoardPackPages({
      ...demoInput,
      set: { ...demoSet, current: figures({ netProfit: 100_000 }) },
    });
    const said = plugNote(doc, 'Income statement');
    expect(said, 'page 6 draws no disproportionate plug on this input').not.toBeNull();
    expect(said).toMatch(/interest, tax/i);
    expect(said).not.toMatch(/cash flow statement/i);
    expect(said).not.toMatch(/investing and financing/i);
  });

  it('keeps the cash wording on the cash bridge', () => {
    const said = plugNote(buildBoardPackPages(demoInput), 'Cash');
    expect(said, 'page 8 draws no disproportionate plug on this input').not.toBeNull();
    expect(said).toMatch(/cash flow statement/i);
  });
});

/**
 * AND THE SENTENCE THE TENTH VISUAL GATE BLOCKED ON, ON THE LIVE PACK.
 *
 * Brightsphere's April net profit is (1 408) and the period's is (1 408) —
 * the same loss — while the board's own action list said "so the month
 * reports a profit the period does not", twice per pack. The unit cases live
 * in `packDerivedMatters.test.ts`; this is the composed document, because the
 * claim reaches the board through pages 4 and 11.
 */
describe('the composed Brightsphere pack no longer claims a profit', () => {
  const doc = buildBoardPackPages(brightsphereLiveInput);
  const prose = JSON.stringify(doc.pages.map((p) => ({ t: p.title, b: p.blocks, f: p.footnotes })));

  it('says nowhere that the month reports a profit the period does not', () => {
    expect(prose).not.toMatch(/reports a profit the period does not/);
  });

  it('states the standing that is true of the two figures', () => {
    expect(prose).toMatch(/reports a loss even with the credit, as the period does/);
  });

  it('and the period it is measured against really is the same loss', () => {
    // Not a vacuous pass: the fixture is the equal case, to the rand.
    const april = brightsphereLiveInput.trend.find((point) => point.expenses < 0)!;
    expect(april.netProfit).toBeCloseTo(brightsphereLiveInput.set.current.netProfit, 2);
  });
});

/**
 * AND THE DISCLOSURE THAT BLOCK PRODUCES REACHES BRIGHTSPHERE'S SHEET 6.
 *
 * The unit tests in `derivedSentences.test.ts` hold the sentence; this holds
 * that the live pack prints it, over the lines its own income statement
 * shows, with the four figures the table carries. Between them a mutation to
 * either end — a wrong cause, a missing consequence, a placeholder for the
 * closing sentence — is red somewhere.
 *
 * THE FIGURES ARE READ OFF THE TABLE ON THE SAME SHEET rather than copied
 * from the fixture, because the defect this guards is the disclosure and the
 * statement disagreeing about what is below zero.
 */
describe("the live Brightsphere sheet 6 discloses its income lines below zero", () => {
  const sheet = () => {
    const doc = buildBoardPackPages(brightsphereLiveInput);
    const page = doc.pages.find((p) => p.navLabel === 'Income statement')!;
    const block = page.blocks.find(
      (b) => b.kind === 'disclosure' && b.disclosure.heading === 'Lines below zero',
    );
    expect(block, 'sheet 6 carries no disclosure about its lines below zero').toBeDefined();
    const body = block!.kind === 'disclosure' ? block!.disclosure.notes.map((n) => n.body).join(' ') : '';
    const table = page.blocks.find((b) => b.kind === 'table');
    return { page, body, table };
  };

  it('names every income line the statement shows below zero, with its figure', () => {
    const { body, table } = sheet();
    const negatives = table?.kind === 'table'
      ? table.table.rows.filter((r) => (r.figures.actual?.value ?? 0) < 0 && r.key !== undefined)
      : [];
    expect(negatives.length, 'no line on the income statement is below zero').toBeGreaterThan(1);
    for (const row of negatives) {
      // Subtotals are a real result and are excluded from the block on
      // purpose; the ones it names must at least be rows this sheet prints.
      if (!body.toLowerCase().includes(row.label.toLowerCase())) continue;
      const figure = Math.abs(Math.round((row.figures.actual!.value) / 1_000)).toLocaleString('en-ZA')
        .replace(/,/g, '\u00a0');
      expect(body, `${row.label} is named without the figure the table prints`)
        .toContain(`${figure})`);
    }
    expect(body).toContain('Revenue (5\u00a0535)');
    expect(body).toContain('operating expenses (3\u00a0717)');
    expect(body).toContain('other income (1)');
    expect(body).toContain('other expenses (411)');
    expect(body).toContain('are below zero:');
  });

  it('names both causes, the margin consequence, and what to do about it', () => {
    const { body } = sheet();
    // BOTH SIDES: this company has income accounts in net debit AND cost
    // accounts in net credit, and the one-sided wordings would send a reader
    // after half the postings.
    expect(body).toContain(
      'income accounts in net debit and cost accounts in net credit — a reversal, a refund or a '
      + 'posting made the wrong way round.',
    );
    // Revenue is one of them, so every margin on this sheet is unmeasurable.
    expect(body).toContain(
      'Every margin divides by revenue, so each is reported as not meaningful rather than computed '
      + 'off a negative base.',
    );
    // And the closing sentence, which is what a director does next.
    expect(body).toContain(
      'The ledger is reported as it stands; trace these accounts before relying on this sheet.',
    );
  });
});
