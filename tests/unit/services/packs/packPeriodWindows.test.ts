/**
 * THE PACK MUST NOT CONTRADICT ITSELF ABOUT A WINDOW OR A COMPARATIVE.
 *
 * Two defect classes, one file, because they are the same mistake twice: a
 * page stating something about the document that the document does not
 * support.
 *
 *  1. The trends page carried a hard-coded note reconciling gross margin
 *     against the income statement page — printed on a pack that draws no
 *     gross-margin panel, two centimetres above a disclosure explaining why
 *     that panel could not be drawn.
 *  2. The highlights page told a director "No comparative period" eight times
 *     while four statement pages printed a prior column and the basis page
 *     named the comparative's dates. The comparative was there; what was
 *     missing was a usable percentage BASE, and one null on `delta` was
 *     carrying both meanings.
 *
 * Both are asserted BOTH WAYS on every fixture — present where it should be,
 * absent where it should not. A one-directional check on either would pass on
 * a builder that emits the note always, or never.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { buildHighlightTiles } from '@/modules/accounting/services/packs/pages/packHighlights';
import { PackFigureProvenance } from '@/modules/accounting/services/packs/figures/packFigureProvenance';
import { tileCaption } from '@/modules/accounting/services/packs/narrative/derivedCaptions';
import {
  trendWindowNote,
  periodWindowFootnotes,
} from '@/modules/accounting/services/packs/pages/packTrendCrossReference';
import { PERIOD_COUNTERPARTS } from '@/modules/accounting/services/packs/pages/packTrendCrossReference';
import { buildTrendPanels } from '@/modules/accounting/services/packs/pages/packPageCharts';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { cashTitle } from '@/modules/accounting/services/packs/narrative/derivedSentences';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { brightsphereInput, demoInput, noRatioPanelsInput } from './fixtures/boardPackInputs';
import { liveDemoInput, liveDemoRenderedInput, liveDemoSet } from './fixtures/liveDemoBoardPack';

const FIXTURES: Array<[string, BoardPackInput]> = [
  ['demo', demoInput],
  ['brightsphere', brightsphereInput],
  ['no ratio panels', noRatioPanelsInput],
  ['live', liveDemoInput],
];

/** Every word the document prints, as one string — disclosure notes, derived
 *  commentary, page titles, footnotes and tile captions alike. A note that
 *  moves between blocks must not be able to escape this. */
function prose(doc: PackPagesDocument): string {
  const parts: string[] = [];
  for (const page of doc.pages) {
    parts.push(page.title, page.navLabel, ...page.footnotes.map((f) => f.text));
    for (const block of page.blocks) {
      if (block.kind === 'disclosure') {
        parts.push(block.disclosure.heading, ...block.disclosure.notes.flatMap((n) => [n.heading, n.body]));
      }
      if (block.kind === 'narrative') parts.push(block.narrative.body ?? '', ...(block.boardActions ?? []));
      if (block.kind === 'kpiTiles') parts.push(...block.tiles.map(tileCaption));
      if (block.kind === 'chart') parts.push(block.chart.title);
      if (block.kind === 'smallMultiples') parts.push(...block.panels.map((p) => p.title));
    }
  }
  return parts.join('\n');
}

/**
 * A PART MONTH IS NOT A POINT ON PAGE 10, AND THE PAGE SAYS SO.
 *
 * Page 10 used to end its panels on the stub and qualify it in words: "Gross
 * margin fell from 5323.5% to 100.0% in Sep 2026 (part)", with a clause that
 * a ratio there is "not comparable with the months before it". A qualified
 * comparison is still a comparison, and Velocity Fibre's page headlined
 * "Revenue is down 100.0%" off two days of October. The panels now draw whole
 * months only (`wholeMonthsOf`), and the Period note names the month left out
 * — exactly when there is one.
 */
describe('the part month on page 10', () => {
  const PART_FIXTURES: Array<[string, BoardPackInput]> = [
    ['the live demo company as it renders', liveDemoRenderedInput],
    ...FIXTURES,
  ];

  for (const [name, input] of PART_FIXTURES) {
    it(`is left out and named exactly when the window ends on one — ${name}`, () => {
      const stub = input.trend.find((p) => p.partial) ?? null;
      const built = buildTrendPanels(input.trend, PACK_SCALE);
      expect(built.partMonthLeftOut?.label ?? null).toBe(stub?.label ?? null);
      for (const panel of built.panels) expect(panel.title).not.toContain('(part)');

      const note = trendWindowNote(built.panels, built.partMonthLeftOut);
      if (built.panels.length === 0) {
        expect(note).toBeNull();
        return;
      }
      expect(note!.body.includes(`${stub?.label} is a part month and is not drawn.`)).toBe(stub !== null);
    });
  }

  // NOT VACUOUS: both cases must be reached.
  it('has a fixture on each side', () => {
    const withStub = PART_FIXTURES.filter(([, input]) => input.trend.some((p) => p.partial));
    expect(withStub.length).toBeGreaterThan(0);
    expect(withStub.length).toBeLessThan(PART_FIXTURES.length);
  });
});

describe('the month-versus-period note', () => {
  for (const [name, input] of FIXTURES) {
    it(`names every measure ${name} draws a panel for, and no other`, () => {
      const panels = buildTrendPanels(input.trend, PACK_SCALE).panels;
      const note = trendWindowNote(panels);
      const drawn = new Set(panels.map((p) => p.id));

      if (drawn.size === 0) {
        expect(note, 'a page with no panels must carry no note reconciling them').toBeNull();
        return;
      }

      // The note names a measure IF AND ONLY IF its panel is drawn AND its
      // page prints it against the comparative — which is what the sentence
      // claims. Both halves matter: naming a measure whose panel is absent
      // was the original defect, and naming gross margin, whose panel IS
      // drawn on the demo but whose page carries no comparative for it, was
      // the second. Read off `printsAgainstComparative` rather than a list
      // typed here, so the test cannot drift from the rule.
      expect(note).not.toBeNull();
      //
      // AND IT NAMES EVERY DRAWN PANEL, including the one whose page carries
      // no comparative for it. Dropping gross margin from the list was the
      // round before this one's fix and it left the sentence mapping 5 of the
      // sheet's 6 panels; the measure is back and the comparative claim
      // carries its own exception instead.
      expect(note!.body.includes('gross margin')).toBe(drawn.has('trend-gross-margin'));
      expect(note!.body.includes('debtor days')).toBe(drawn.has('trend-debtor-days'));
      expect(note!.body.includes('cash')).toBe(drawn.has('trend-cash'));
      // The exception is stated exactly where a drawn panel lacks one.
      // THE EXCEPTION SET IS TWO HALVES NOW. `printsAgainstComparative` is
      // the structural one — page 6 carries no comparative COLUMN for gross
      // margin — and the second is whether the destination cell prints a
      // figure at all: the demo pack's page 9 shows Debtor days PRIOR as
      // `n/m`, the same state, and the sentence named gross margin alone.
      // This call passes no reading, so the default says every cell prints
      // one and only the structural half can fire.
      const without = [...drawn].filter((id) => !PERIOD_COUNTERPARTS[id]!.printsAgainstComparative);
      expect(/with a comparative except /.test(note!.body)).toBe(without.length > 0);
      // And gross margin is the measure that differs, so this can fail.
      expect(PERIOD_COUNTERPARTS['trend-gross-margin']!.printsAgainstComparative).toBe(false);
    });

    it(`does not name a missing panel anywhere on ${name}'s trends page`, () => {
      // Read off the composed DOCUMENT rather than the builder, because the
      // contradiction was between two blocks on one page: the note above and
      // the "Panels not drawn" disclosure below it.
      const doc = buildBoardPackPages(input);
      const trends = doc.pages.find((p) => p.navLabel === 'Trends')!;
      const text = trends.blocks
        .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes.map((n) => n.body) : []))
        .join('\n');
      const drawn = new Set(buildTrendPanels(input.trend, PACK_SCALE).panels.map((p) => p.id));

      // "Panels not drawn" explains gross margin's absence in the same words
      // the window note would use to claim its presence. Only one of the two
      // may be on the page.
      //
      // The trends page no longer CLAIMS gross margin at all — page 6 prints
      // it only in the `% of revenue` column, which has no comparative — so
      // what this now holds is the direction that still matters: a page that
      // does not draw the panel must not claim it. The reciprocal footnote on
      // page 6 is where the drawn case is checked, in the test below.
      const claimsGrossMargin = /Gross margin.*(income statement|for the WHOLE)|gross margin on the income statement/i.test(text);
      expect(claimsGrossMargin, `${name}: the trends page names a gross-margin panel it does not draw`)
        .toBe(drawn.has('trend-gross-margin'));
    });

    it(`gives ${name}'s statement pages the reciprocal pointer only where the panel exists`, () => {
      const panels = buildTrendPanels(input.trend, PACK_SCALE).panels;
      const drawn = new Set(panels.map((p) => p.id));
      const doc = buildBoardPackPages(input);

      const income = doc.pages.find((p) => p.navLabel === 'Income statement')!;
      expect(income.footnotes.some((f) => /trends page/.test(f.text)))
        .toBe(drawn.has('trend-gross-margin'));

      const scorecard = doc.pages.find((p) => p.navLabel === 'Scorecard')!;
      expect(scorecard.footnotes.some((f) => /trends page/.test(f.text)))
        .toBe(drawn.has('trend-debtor-days'));
    });
  }

  it('issues the reciprocal footnote at the number the page asks for', () => {
    // The PAGE owns its footnote numbering — the income statement already
    // carries two statement notes, and a third that renumbered itself to 1
    // would print two footnote 1s on one sheet.
    const panels = buildTrendPanels(demoInput.trend, PACK_SCALE).panels;
    expect(periodWindowFootnotes(panels, 'trend-gross-margin', 'Income statement', 3)[0]?.number).toBe(3);
    expect(periodWindowFootnotes(panels, 'trend-debtor-days', 'Scorecard', 1)[0]?.number).toBe(1);
    // And nothing at all for a panel this trend does not draw.
    const none = buildTrendPanels(liveDemoInput.trend, PACK_SCALE).panels;
    expect(periodWindowFootnotes(none, 'trend-gross-margin', 'Income statement', 3)).toEqual([]);
  });
});

/**
 * A POINTER IS A CLAIM ABOUT ANOTHER SHEET, AND IT IS CHECKED AGAINST THAT
 * SHEET.
 *
 * The Period note sent net profit to the MONTHLY RESULTS page, which prints net
 * profit by month and a total over the trend window — no reporting-period
 * figure and no comparative column anywhere on it. The period's net profit is
 * on the income statement, (1 544) against (905). A director who followed the
 * pointer did not find nothing; the monthly results page's total row reads
 * (1 901), so they found a plausible wrong number, which is worse.
 *
 * The five other pointers in that sentence were right, so nothing about the
 * mechanism was broken and no string assertion on the sentence would have
 * caught it. What catches it is reading the DESTINATION: the page the note
 * names must actually print that measure for the whole period, against the
 * comparative.
 *
 * ON THE DEMO SHAPE, and that is not a convenience. Brightsphere's activity
 * sits in one month, so its group-results total and its income statement's
 * period figure are the same number and the wrong pointer leads to the right
 * one. A fixture whose months are spread is the only place the pack exposes
 * this.
 */
describe('the page the trends note names carries the figure it promises', () => {
  it('sends net profit to a sheet that prints it for the period, against a comparative', () => {
    const doc = buildBoardPackPages(liveDemoRenderedInput);
    const trends = doc.pages.find((p) => p.navLabel === 'Trends')!;
    const period = trends.blocks
      .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes : []))
      .find((n) => n.heading === 'Period');
    expect(period, 'sheet 10 carries no Period note to check').toBeDefined();

    // The page is read OUT of the sentence, so the assertion follows whatever
    // the note actually says rather than a second copy of the right answer.
    const named = /net profit on the ([a-z ]+) page/.exec(period!.body)?.[1];
    expect(named, `the Period note names no page for net profit: ${period!.body}`).toBeDefined();

    const destination = doc.pages.find((p) => p.navLabel.toLowerCase() === named);
    expect(destination, `net profit is sent to a "${named}" page this pack does not have`)
      .toBeDefined();

    const rows = destination!.blocks.flatMap((b) => (b.kind === 'table' ? b.table.rows : []));
    const netProfit = rows.find((r) => /^net profit$/i.test(r.label));
    expect(netProfit, `the ${named} page prints no net profit row for the reporting period`)
      .toBeDefined();
    expect(typeof netProfit!.figures.actual?.value,
      `the ${named} page's net profit carries no period figure`).toBe('number');
    expect(typeof netProfit!.figures.prior?.value,
      `the ${named} page's net profit carries no comparative`).toBe('number');
  });

  /**
   * THE PREMISE, HELD SEPARATELY. If the monthly results page ever grew a net
   * profit row against a comparative, the assertion above would pass on the
   * old wrong pointer and this fixture would stop being able to tell the two
   * apart — so the shape that makes the test meaningful is asserted, not
   * assumed.
   */
  it('is a fixture where the monthly results page could not answer for the period', () => {
    const doc = buildBoardPackPages(liveDemoRenderedInput);
    const results = doc.pages.find((p) => p.navLabel === 'Monthly results')!;
    const rows = results.blocks.flatMap((b) => (b.kind === 'table' ? b.table.rows : []));
    expect(rows.length, 'the monthly results page draws no table at all').toBeGreaterThan(0);
    expect(rows.map((r) => r.label).filter((l) => /^net profit$/i.test(l)),
      'the monthly results page now prints a net profit row, so the pointer test proves nothing')
      .toEqual([]);
    const columns = results.blocks.flatMap((b) => (b.kind === 'table' ? b.table.columns : []));
    expect(columns, 'the monthly results page now carries a comparative column').not.toContain('prior');

    // And the number a reader WOULD have found there is not the one the
    // sentence promised: the window total against the period figure.
    const total = rows.find((r) => r.role === 'total')!;
    const income = doc.pages.find((p) => p.navLabel === 'Income statement')!;
    const period = income.blocks.flatMap((b) => (b.kind === 'table' ? b.table.rows : []))
      .find((r) => /^net profit$/i.test(r.label))!;
    expect(total.figures.netProfit?.value,
      'the two windows coincide on this fixture, so it cannot expose a wrong pointer')
      .not.toBe(period.figures.actual?.value);
  });
});

describe('what the pack says about its comparative period', () => {
  for (const [name, input] of FIXTURES) {
    it(`does not deny ${name}'s comparative period on any page that has one`, () => {
      const doc = buildBoardPackPages(input);
      const says = prose(doc);
      const denial = /no comparative period/i;

      if (doc.comparativePeriod === null) {
        // The other direction: a pack with no comparative must SAY so, or the
        // check above is satisfied by a document that never mentions it.
        expect(denial.test(says), `${name} has no comparative period and never says so`).toBe(true);
        return;
      }

      expect(denial.test(says), `${name} prints a comparative column but tells the reader there is none`)
        .toBe(false);
      // And it names the comparative the basis page names, on the tiles page.
      const highlights = doc.pages.find((p) => p.navLabel === 'Highlights')!;
      const notes = highlights.blocks
        .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes.map((n) => n.body) : []))
        .join('\n');
      expect(notes).toContain(doc.comparativePeriod.label);
    });
  }

  it('tells a tile with an unusable base apart from a tile with no comparative', () => {
    // The live demo company: a real comparative period whose revenue is nil
    // and whose net profit is (905). Every tile's delta is null, and the
    // reason is NOT that there is no comparative.
    expect(liveDemoSet.prior, 'this fixture is the has-a-comparative case').not.toBeNull();
    const tiles = buildHighlightTiles(liveDemoSet, liveDemoInput.trend, new PackFigureProvenance());

    // Exactly one of the two is set, on every tile — the invariant the model
    // declares, which is what stops a caption falling back to a wrong reason.
    for (const tile of tiles) {
      expect((tile.delta === null) !== (tile.deltaAbsence === null), tile.label).toBe(true);
    }

    const reasons = new Map(tiles.map((t) => [t.label, t.deltaAbsence]));
    expect(reasons.get('Net profit')).toBe('unusableBase');
    expect(reasons.get('Cash')).toBe('unusableBase');
    // Debtor days has no prior VALUE at all — the prior period earned no
    // revenue, so days of sales outstanding cannot be measured on it. That is
    // a third statement again, and it is not "no comparative period".
    expect(reasons.get('Debtor days')).toBe('noPriorValue');
    expect([...reasons.values()]).not.toContain('noComparativePeriod');

    for (const tile of tiles) {
      expect(tileCaption(tile), tile.label).not.toMatch(/no comparative period/i);
    }
  });

  it('still says "no comparative period" where there genuinely is none', () => {
    // Brightsphere: first period, no prior. Without this the check above is
    // satisfied by deleting the sentence.
    const tiles = buildHighlightTiles(brightsphereInput.set, brightsphereInput.trend, new PackFigureProvenance());
    expect(brightsphereInput.set.prior).toBeNull();
    expect(tiles.every((t) => t.deltaAbsence === 'noComparativePeriod' || t.deltaAbsence === 'noCurrentValue')).toBe(true);
    expect(tiles.some((t) => /no comparative period/i.test(tileCaption(t)))).toBe(true);
  });
});

describe('the no-comparative-base sentence', () => {
  it('does not measure a base against a base', () => {
    // "Net profit of (1 546); the comparative profit base is measured against
    // a negative comparative base, so the percentage change is not
    // meaningful." — the second sentence a director read on sheets 4 and 8.
    // SHEET 8 STILL SAYS IT IN THE HEADLINE. Its headline is a LEVEL —
    // "Cash stands at (531)" — and the clause completes that sentence rather
    // than displacing a finding, so it stays where it is.
    const cash = cashTitle(liveDemoSet, PACK_SCALE);
    expect(cash).not.toMatch(/base is measured against .* base/i);
    expect(cash).toMatch(/comparative .* figure is negative/i);

    // SHEET 4 NO LONGER HAS A DENOMINATOR TO APOLOGISE FOR. Its headline was
    // a net-profit level with the missing-percentage clause behind it; the
    // tenth gate failed it on criterion 1, because the page's payload is a
    // panel of board decisions and the value was already headlined twice
    // elsewhere. `narrativeTitle` is now about the matters this sheet prints,
    // so neither the clause nor the footnote that carried it exists.
    // Both fixtures exercise the negative branch, so neither passes vacuously.
    expect(liveDemoSet.prior!.netProfit).toBeLessThan(0);
    expect(liveDemoSet.prior!.cash).toBeLessThan(0);
  });
});
