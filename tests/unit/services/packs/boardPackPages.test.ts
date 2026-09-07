/**
 * The twelve-page board pack, composed.
 *
 * Two fixtures, and the second is the one that matters. `demoInput` is a
 * healthy company with a prior period and a budget — it can only ever
 * exercise the happy path, so on its own it would leave every null-prior and
 * null-budget branch in this pack unreached. `brightsphereInput` mirrors the
 * real client: negative revenue, negative equity, no prior period, no budget.
 *
 * The block-content assertions exist because "at least three blocks" passes
 * trivially on three EMPTY blocks. A page carrying an empty table, an empty
 * tile strip and an unapproved narrative satisfies the count and ships a
 * blank page, which is the defect spec §5.7 names.
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import {
  assertPageTitleIsAMessage,
  type PackPageBlock,
} from '@/modules/accounting/services/packs/pages/packPageModel';
import type { PackFigureSet } from '@/modules/accounting/services/packs/figures/packFigureSet';
import type { ReportPackFigures } from '@/modules/accounting/services/reports/reportPackDataService';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';
import type { PackMatter } from '@/modules/accounting/services/packs/pages/packMatters';
import type { PackBrand } from '@/modules/accounting/services/packs/packBrand';
import { formatMoney, pctWithWord, toMoneyScale } from '@/lib/format/money';
import { marginPct } from '@/modules/accounting/services/reports/marginPct';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { CHART_HEIGHT_MM } from '@/lib/charts/ssrSvg';
import { formatFigureText } from '@/components/accounting/packs/primitives/packFigureText';
import { TRENDS_PANELS_SPECIFIED } from '@/modules/accounting/services/packs/pages/packPageCharts';
import {
  brightsphereInput,
  brightsphereSet,
  demoInput,
  demoSet,
  figures,
  noRatioPanelsInput,
  pageWithTableRow,
  trend,
} from './fixtures/boardPackInputs';


/** Whether a block puts anything on the page. Counting blocks is not enough. */
function blockHasContent(block: PackPageBlock): boolean {
  switch (block.kind) {
    case 'kpiTiles':
      return block.tiles.length > 0;
    case 'statTiles':
      return block.groups.length > 0 && block.groups.every((g) => g.stats.length > 0);
    case 'table':
      return block.table.rows.length > 0 && block.table.columns.length > 0;
    case 'scorecard':
      return block.groups.length > 0 && block.groups.every((g) => g.rows.length > 0);
    case 'chart':
      return block.chart.svg.length > 0;
    case 'smallMultiples':
      return block.panels.length > 0 && block.panels.every((p) => p.svg.length > 0);
    case 'narrative':
      // A 'pending' narrative renders a visible placeholder (NarrativeColumns);
      // a 'draft' one renders literally nothing and is never page content.
      // 'derived' renders its body under a "derived" source label — R-P49 —
      // so it is content on exactly the same terms as 'approved'.
      return block.narrative.status === 'pending'
        ? true
        : (block.narrative.status === 'approved' || block.narrative.status === 'derived')
          && (block.narrative.body ?? '').trim() !== '';
    case 'disclosure':
      return block.disclosure.notes.length > 0
        && block.disclosure.notes.every((n) => n.body.trim() !== '');
    case 'definitions':
      return block.entries.length > 0;
    case 'matters':
      // `buildMatters` never returns an empty list — an empty result is an
      // explicit "no matters" item, so an empty block here means the page
      // lost its content rather than that the checks came back clean.
      return block.matters.length > 0 && block.matters.every((m) => m.issue.trim() !== '');
  }
}

describe('buildBoardPackPages', () => {
  const doc = buildBoardPackPages(demoInput);

  it('is exactly twelve pages, numbered 1..12', () => {
    expect(doc.pages.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('titles every content page with a message', () => {
    for (const page of doc.pages) {
      expect(() => assertPageTitleIsAMessage(page.title, page.number), `page ${page.number}`).not.toThrow();
    }
  });

  it('gives every page its own title — no two pages say the same thing', () => {
    const titles = doc.pages.map((p) => p.title);
    expect(new Set(titles).size).toBe(12);
  });

  it('puts a chart on the results, position, cash and trends pages', () => {
    for (const n of [6, 7, 8, 10]) {
      const page = doc.pages.find((p) => p.number === n)!;
      expect(page.blocks.some((b) => b.kind === 'chart' || b.kind === 'smallMultiples'), `page ${n}`).toBe(true);
    }
  });

  it('gives every content page at least three blocks', () => {
    for (const page of doc.pages.filter((p) => p.number >= 3 && p.number !== 4)) {
      expect(page.blocks.length, `page ${page.number}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('puts content in every block it emits, on both fixtures', () => {
    for (const source of [doc, buildBoardPackPages(brightsphereInput)]) {
      for (const page of source.pages) {
        for (const block of page.blocks) {
          expect(blockHasContent(block), `page ${page.number} block ${block.kind}`).toBe(true);
        }
      }
    }
  });

  it('keeps the narrative page free of tabular figures, per spec §4.A page 4', () => {
    const page = doc.pages.find((p) => p.number === 4)!;
    // BOTH of §4.A's columns are prose, and so is the note saying where each
    // came from. What the rule forbids is a FIGURE block — a table, a tile
    // strip, a scorecard, a chart — not prose in more than one shape.
    expect(page.blocks.every((b) => b.kind === 'narrative' || b.kind === 'disclosure')).toBe(true);
    expect(page.blocks.some((b) => b.kind === 'narrative')).toBe(true);
  });

  it('fills page 4\'s action panel from the matters, approved commentary or not', () => {
    // The page was built as commentary-ONLY, so with nothing approved it
    // printed one italic line at 1.0% fill on a sheet of its own — and the
    // remedy taken first was to merge it away, which made the pack eleven
    // pages for one company and twelve for another. §4.A specifies a second
    // column and it was simply never populated (R-P57).
    for (const input of [demoInput, brightsphereInput]) {
      const built = buildBoardPackPages(input);
      const block = built.pages.find((p) => p.number === 4)!.blocks
        .find((b) => b.kind === 'narrative');
      expect(block?.kind === 'narrative' && block.boardActions, input.companyLegalName)
        .toEqual(expect.arrayContaining([expect.any(String)]));
    }
  });

  it('still says commentary is pending when nothing has been approved', () => {
    // Filling the action panel must not become a way to stop saying that
    // commentary is owed and unwritten — the plan's Global Constraints are
    // explicit that pages 4 and 11 fall back to a VISIBLE placeholder.
    const built = buildBoardPackPages(brightsphereInput);
    const block = built.pages.find((p) => p.number === 4)!.blocks
      .find((b) => b.kind === 'narrative');
    expect(block?.kind === 'narrative' && block.narrative.status).toBe('pending');
  });

  it('renders the trends page landscape and every other page portrait', () => {
    expect(doc.pages.find((p) => p.number === 10)?.orientation).toBe('landscape');
    expect(doc.pages.filter((p) => p.orientation === 'landscape')).toHaveLength(1);
  });

  it('shows a comparative on every KPI and every statement row that has one', () => {
    const tiles = doc.pages.find((p) => p.number === 3)!.blocks
      .flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []));
    expect(tiles.length).toBe(8);
    expect(tiles.every((t) => t.delta !== null)).toBe(true);
  });

  it('states the comparison basis on every delta it prints', () => {
    const tiles = doc.pages.find((p) => p.number === 3)!.blocks
      .flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []));
    expect(tiles.every((t) => (t.delta?.basis ?? '').trim() !== '')).toBe(true);
  });

  it('carries the prior column on the statement tables when there is a prior period', () => {
    for (const n of [5, 6, 7, 8]) {
      const tables = doc.pages.find((p) => p.number === n)!.blocks
        .flatMap((b) => (b.kind === 'table' ? [b.table] : []));
      expect(tables.length, `page ${n}`).toBeGreaterThan(0);
      expect(tables.every((t) => t.columns.includes('prior')), `page ${n}`).toBe(true);
    }
  });

  it('renders the supplied ledger version on the basis page, not an invented one', () => {
    expect(doc.basisOfPreparation.ledgerVersion).toBe('31 August 2026 at 12:00 SAST');
  });

  it('survives a company with no prior period, no budget and negative revenue', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    // TWELVE, for every company (R-P57). The pack's page count must not
    // depend on whether a human has typed commentary: the contents index a
    // fixed sequence, the footer prints `n / m`, and a director comparing two
    // months' packs must not see the structure move.
    expect(doc2.pages).toHaveLength(12);
    expect(doc2.pages.map((p) => p.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    for (const page of doc2.pages) {
      expect(() => assertPageTitleIsAMessage(page.title, page.number), `page ${page.number}`).not.toThrow();
    }
    // Page 4 is exempt from the three-block rule and from nothing else: §4.A
    // gives it two prose columns and the note that sources them.
    for (const page of doc2.pages.filter((p) => p.number >= 3 && p.number !== 4)) {
      expect(page.blocks.length, `page ${page.number}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('fabricates no comparative for a company with no prior period', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    for (const page of doc2.pages) {
      for (const block of page.blocks) {
        if (block.kind === 'table') {
          for (const column of ['prior', 'change', 'changePct'] as const) {
            expect(block.table.columns.includes(column), `page ${page.number} ${column}`).toBe(false);
          }
        }
        if (block.kind === 'kpiTiles') {
          expect(block.tiles.every((t) => t.delta === null), `page ${page.number}`).toBe(true);
        }
        if (block.kind === 'scorecard') {
          expect(block.groups.flatMap((g) => g.rows).every((r) => r.prior === null)).toBe(true);
        }
      }
    }
  });

  it('states the ledger version is unavailable rather than inventing one', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    expect(doc2.basisOfPreparation.ledgerVersion).toMatch(/unavailable/i);
  });

  it('renders a visible pending placeholder where commentary is not approved', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    // Both places a human is expected to write — the period commentary and
    // the commentary on the matters — still say so. Located by search rather
    // than by page number: the narrative page merges into page 3 when there
    // is nothing approved to put on it, so 4 and 11 are not its addresses on
    // this pack.
    const pendingPages = doc2.pages.filter((p) => p.blocks
      .some((b) => b.kind === 'narrative' && b.narrative.status === 'pending'));
    expect(pendingPages).toHaveLength(2);
    for (const page of pendingPages) {
      const narratives = page.blocks.flatMap((b) => (b.kind === 'narrative' ? [b.narrative] : []));
      expect(narratives.every((x) => x.status !== 'draft'), `page ${page.number}`).toBe(true);
      // And never alone on a page — the defect this merge exists to fix.
      expect(page.blocks.length, `page ${page.number}`).toBeGreaterThan(1);
    }
  });

  // The 1000x defect: `PackTable.scale` said "R'000" while `formatMoney` had
  // no scale handling at all, so R4 200 000 printed as `4 200 000` under a
  // thousands header. Eighteen tests passed because not one read a formatted
  // cell against the header above it. This is that assertion.
  it('formats a statement cell at the scale its own header states', () => {
    const scale = toMoneyScale(doc.numberConvention.scale);
    expect(scale, doc.numberConvention.scale).not.toBeNull();

    const table = doc.pages.find((p) => p.number === 5)!.blocks
      .flatMap((b) => (b.kind === 'table' ? [b.table] : []))[0]!;
    expect(table.scale).toBe(doc.numberConvention.scale);

    const revenue = table.rows.find((r) => r.label === 'Revenue')!.figures.actual!;
    expect(revenue.value).toBe(4_200_000);
    expect(formatFigureText(revenue, scale!)).toBe('4 200');
  });

  it('keeps every model figure RAW, so no display scale reaches the integrity gate', () => {
    const recorded = doc.provenance.all().get('packFigureSet.current.revenue')!;
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((f) => f.value === 4_200_000)).toBe(true);
  });

  it('states its scale in every table header', () => {
    for (const page of doc.pages) {
      for (const block of page.blocks) {
        if (block.kind === 'table') expect(block.table.scale, `page ${page.number}`).toBe(doc.numberConvention.scale);
      }
    }
  });

  // Brightsphere's net-debit revenue drove `debtorDays` negative and printed
  // "-4 days". Nothing inspected a tile VALUE, only counts and nullness of
  // deltas, which is why it shipped.
  it('prints no figure whose value is an artefact of an impossible base', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    const tiles = doc2.pages.find((p) => p.number === 3)!.blocks
      .flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []));
    for (const label of ['Debtor days', 'Debt-to-equity', 'Gross margin']) {
      const tile = tiles.find((t) => t.label === label)!;
      expect(tile.figure.value, label).toBeNull();
      expect(tile.figure.unavailable, label).toBeTruthy();
    }
    // And nothing anywhere in the pack reports a negative day count.
    for (const list of doc2.provenance.all().values()) {
      for (const figure of list) {
        if (figure.format === 'days' && figure.value !== null) {
          expect(figure.value, figure.source).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });

  it('foots the profit bridge on its own endpoints', () => {
    const chart = doc.pages.find((p) => p.number === 6)!.blocks
      .flatMap((b) => (b.kind === 'chart' ? [b.chart] : []))[0]!;
    const bars = chart.waterfallBars!;
    expect(bars.length).toBeGreaterThan(3);
    expect(bars[0]!.kind).toBe('open');
    expect(bars[bars.length - 1]!.kind).toBe('close');
    expect(bars[bars.length - 1]!.end).toBe(demoSet.current.netProfit);
    // Every bar that is not a subtotal reset continues from the previous end.
    for (let i = 1; i < bars.length; i += 1) {
      if (bars[i]!.start !== 0) expect(bars[i]!.start, bars[i]!.label).toBe(bars[i - 1]!.end);
    }
  });

  it('closes the cash bridge on the closing balance, plug included', () => {
    const chart = doc.pages.find((p) => p.number === 8)!.blocks
      .flatMap((b) => (b.kind === 'chart' ? [b.chart] : []))[0]!;
    const bars = chart.waterfallBars!;
    expect(bars[0]!.end).toBe(demoSet.prior!.cash);
    expect(bars[bars.length - 1]!.end).toBe(demoSet.current.cash);
    // The last MOVEMENT bar must land exactly on the closing bar — that is
    // what the named "Unexplained movement" plug is for.
    expect(bars[bars.length - 2]!.end).toBe(demoSet.current.cash);
  });

  it('tells the reader the cash bridge carries an unexplained movement', () => {
    // The caption is a DERIVED narrative since R-P49, not a disclosure note.
    // Both are read here so the assertion holds wherever the caption is
    // carried and cannot pass by finding the sentence in the wrong block.
    const prose = doc.pages.find((p) => p.number === 8)!.blocks.flatMap((b) => {
      if (b.kind === 'disclosure') return b.disclosure.notes.map((n) => n.body);
      if (b.kind === 'narrative') return [b.narrative.body ?? ''];
      return [];
    });
    expect(prose.some((text) => /not explained/i.test(text))).toBe(true);
  });

  it('draws the trends page as LINE panels short enough for a landscape sheet', () => {
    const panels = doc.pages.find((p) => p.number === 10)!.blocks
      .flatMap((b) => (b.kind === 'smallMultiples' ? b.panels : []));
    expect(panels.length).toBeGreaterThan(0);
    expect(panels.every((p) => p.kind === 'line')).toBe(true);
    // Six panels draw three across, so the page carries two rows of them
    // inside a LANDSCAPE content box 168mm tall — at 72mm a row the panels
    // alone came to 164mm, and at the 48mm inline rung two rows came to
    // 104mm, which still spilled once the page titles became visible on
    // paper and for any company whose trend draws fewer than six panels (a
    // disclosure says why, and costs another 21mm). 36mm is deliberately
    // BELOW spec §5.6's rungs: those were set against a 255mm portrait box
    // and this is the one page printed into a 168mm one. The sheet count in
    // tests/unit/print/packSheetCount.test.ts is what actually holds this.
    expect(panels.every((p) => p.heightMm === 36)).toBe(true);
    expect(panels.every((p) => p.heightMm < CHART_HEIGHT_MM.inline)).toBe(true);
  });

  function disclosureHeadings(page: (typeof doc)['pages'][number]): string[] {
    return page.blocks.flatMap((b) => (b.kind === 'disclosure' ? [b.disclosure.heading] : []));
  }

  it('draws all six specified panels when every metric is meaningful, and says nothing about panels not drawn', () => {
    const panels = doc.pages.find((p) => p.number === 10)!.blocks
      .flatMap((b) => (b.kind === 'smallMultiples' ? b.panels : []));
    expect(panels.length).toBe(TRENDS_PANELS_SPECIFIED);
    expect(disclosureHeadings(doc.pages.find((p) => p.number === 10)!)).not.toContain('Panels not drawn');
  });

  it('draws fewer than six panels when a metric is not meaningful all period, and discloses which count is short', () => {
    const shortDoc = buildBoardPackPages(noRatioPanelsInput);
    const page10 = shortDoc.pages.find((p) => p.number === 10)!;
    const panels = page10.blocks.flatMap((b) => (b.kind === 'smallMultiples' ? b.panels : []));
    expect(panels.length).toBeLessThan(TRENDS_PANELS_SPECIFIED);
    expect(disclosureHeadings(page10)).toContain('Panels not drawn');
  });

  it('draws the page-8 closing-cash line from the trend, and it foots on the closing cash figure', () => {
    const chart = doc.pages.find((p) => p.number === 8)!.blocks
      .flatMap((b) => (b.kind === 'chart' ? [b.chart] : []))
      .find((c) => c.id === 'cash-trend')!;
    expect(chart).toBeDefined();
    expect(chart.kind).toBe('line');
    // One vertex per trend period — a structural count, not `svg.length > 0`.
    const seriesPath = chart.svg.match(/stroke="#15202b" stroke-width="2"[^>]*d="([^"]+)"/)
      ?? chart.svg.match(/d="([^"]+)"[^>]*stroke="#15202b" stroke-width="2"/);
    const points = seriesPath![1]!.split(/[ML]/).filter((s) => s.trim() !== '');
    expect(points).toHaveLength(trend.length);
    // The closing value is labelled directly on the chart (spec §4.A's
    // end-labelled small multiple), so the figure itself is checkable in the
    // SVG, not just in the title string — AT THE DOCUMENT'S SCALE, which is
    // what an end label on a chart under an R'000 header must print (R-P52).
    expect(chart.svg).toContain(formatMoney(trend[trend.length - 1]!.cash, { scale: PACK_SCALE }));
    expect(chart.svg).not.toContain(formatMoney(trend[trend.length - 1]!.cash));
    expect(disclosureHeadings(doc.pages.find((p) => p.number === 8)!)).not.toContain('No closing-cash series');
  });

  it('discloses why there is no closing-cash line when there is no trend series at all', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    // The CASH page, found by the table it carries rather than by the number
    // 8 — this pack is eleven pages and the cash page is the seventh of them.
    const page8 = pageWithTableRow(doc2, 'Opening cash')!;
    const chartIds = page8.blocks.flatMap((b) => (b.kind === 'chart' ? [b.chart.id] : []));
    expect(chartIds).not.toContain('cash-trend');
    expect(disclosureHeadings(page8)).toContain('No closing-cash series');
  });

  it('never restates a page title as that page\'s commentary', () => {
    for (const source of [doc, buildBoardPackPages(brightsphereInput)]) {
      for (const page of source.pages) {
        for (const block of page.blocks) {
          // Derived captions are narrative blocks since R-P49; scanning only
          // disclosures would have quietly stopped covering them.
          const bodies = block.kind === 'disclosure'
            ? block.disclosure.notes.map((n) => n.body)
            : block.kind === 'narrative' ? [block.narrative.body ?? ''] : [];
          for (const body of bodies) {
            expect(body.trim(), `page ${page.number}`).not.toBe(page.title.trim());
          }
        }
      }
    }
  });

  it('points every sparkline tile at a real footnote on its own page', () => {
    const highlights = doc.pages.find((p) => p.number === 3)!;
    const numbers = new Set(highlights.footnotes.map((f) => f.number));
    expect(numbers.size).toBeGreaterThan(0);
    const tiles = highlights.blocks.flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []));
    for (const tile of tiles) {
      if (tile.sparklineSvg !== null) expect(numbers.has(tile.trendFootnote!), tile.label).toBe(true);
      else expect(tile.trendFootnote, tile.label).toBeNull();
    }
  });

  // `ReportPackInput.operatingProfit` is OPTIONAL, so undefined is
  // type-reachable. Page 3 read it as null-with-a-reason and the statement
  // tables read the classifier's documented fallback — against the SAME
  // provenance source. Two readings of one source throws in
  // `assertConsistent`, which takes the whole render with it: the pack does
  // not fail a cell, it fails to exist.
  it('renders when the classifier supplied no operating profit line', () => {
    const noOperatingLine = buildBoardPackPages({
      ...demoInput,
      set: {
        ...demoSet,
        current: figures({ operatingProfit: undefined }),
        prior: figures({ revenue: 3_750_000, netProfit: 388_000, operatingProfit: undefined }),
      },
    });
    expect(() => noOperatingLine.provenance.assertConsistent()).not.toThrow();
    expect(noOperatingLine.pages).toHaveLength(12);
    const readings = noOperatingLine.provenance.all().get('packMetricReads.operatingProfit')!;
    expect(readings.length).toBeGreaterThan(1);
    expect(new Set(readings.map((f) => f.value)).size).toBe(1);
    expect(readings[0]!.value).not.toBeNull();
  });

  // Capital expenditure is optional on `ReportPackInput`. Zeroing it reports
  // a company that bought nothing, which is a statement about the business
  // rather than about our data — and the two cash rows beside it already say
  // "not captured" when their own figure is absent (R-P44/R-P45).
  it('says capital expenditure was not captured rather than reporting zero investing', () => {
    const noCapex = buildBoardPackPages({
      ...demoInput,
      set: { ...demoSet, current: figures({ capitalExpenditure: undefined }) },
    });
    const table = noCapex.pages.find((p) => p.number === 8)!.blocks
      .flatMap((b) => (b.kind === 'table' ? [b.table] : []))[0]!;
    const investing = table.rows.find((r) => r.label === 'Investing cash flow')!.figures.actual!;
    expect(investing.value).toBeNull();
    expect(investing.unavailable).toMatch(/capital expenditure/i);
  });

  // THE ASSERTION SHAPE NOTHING HAD: a page title read against the figure
  // printed beside it. The first fix for the operating-line defect turned a
  // loud render failure into a silent contradiction — page 3's title said
  // "Operating margin is 0.0%" beside a tile showing 750 000, and page 5's
  // said "operating profit of 512 000" above a row showing 750 000, because
  // two sentences still read the raw optional field with their own fallbacks.
  it('agrees with the figure beside it in the titles of pages 3 and 5', () => {
    const noOperatingLine = buildBoardPackPages({
      ...demoInput,
      set: { ...demoSet, current: figures({ operatingProfit: undefined }) },
    });
    const tile = noOperatingLine.pages.find((p) => p.number === 3)!.blocks
      .flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []))
      .find((t) => t.label === 'Operating profit')!;
    const row = noOperatingLine.pages.find((p) => p.number === 5)!.blocks
      .flatMap((b) => (b.kind === 'table' ? b.table.rows : []))
      .find((r) => r.label === 'Operating profit')!;

    expect(tile.figure.value).not.toBeNull();
    expect(row.figures.actual!.value).toBe(tile.figure.value);

    // Page 5's title states the operating profit. It must be THAT number, at
    // the scale the tile beside it prints — the title is prose and prose was
    // the layer that printed raw rands under an R'000 header (R-P52).
    expect(noOperatingLine.pages.find((p) => p.number === 5)!.title)
      .toContain(formatMoney(tile.figure.value!, { scale: PACK_SCALE }));

    // Page 3's title states the operating margin. It must be THAT number over
    // this period's revenue, not a margin taken on a defaulted zero.
    const margin = marginPct(tile.figure.value!, demoSet.current.revenue)!;
    expect(noOperatingLine.pages.find((p) => p.number === 3)!.title)
      .toContain(pctWithWord(margin, 'a positive', 'a negative'));
  });

  it('tells the reader that rounded components may not add to the totals', () => {
    for (const number of [5, 6, 7, 8]) {
      const page = doc.pages.find((p) => p.number === number)!;
      expect(page.footnotes.some((f) => /may not add/i.test(f.text)), `page ${number}`).toBe(true);
    }
    const basis = doc.pages.find((p) => p.number === 12)!.blocks
      .flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes : []));
    expect(basis.some((n) => /may not add/i.test(n.body))).toBe(true);
  });

  it('draws no cash-bridge bar for a category the figure set never captured', () => {
    const noCapex = buildBoardPackPages({
      ...demoInput,
      set: { ...demoSet, current: figures({ capitalExpenditure: undefined }) },
    });
    const chart = noCapex.pages.find((p) => p.number === 8)!.blocks
      .flatMap((b) => (b.kind === 'chart' ? [b.chart] : []))[0]!;
    const labels = chart.waterfallBars!.map((b) => b.label);
    // The table one block above says capital expenditure was not captured;
    // a flat Investing bar here would be the same figure telling two stories.
    expect(labels).not.toContain('Investing');
    expect(labels).toContain('Unexplained movement');
    // And the bridge still foots on the closing balance.
    expect(chart.waterfallBars![chart.waterfallBars!.length - 1]!.end).toBe(demoSet.current.cash);
  });

  it('records every figure it renders in the provenance map', () => {
    expect(() => doc.provenance.assertConsistent()).not.toThrow();
    expect([...doc.provenance.all().keys()].length).toBeGreaterThan(30);
  });

  it('keeps the provenance of the hostile case consistent too', () => {
    const doc2 = buildBoardPackPages(brightsphereInput);
    expect(() => doc2.provenance.assertConsistent()).not.toThrow();
    expect([...doc2.provenance.all().keys()].length).toBeGreaterThan(30);
  });
});
