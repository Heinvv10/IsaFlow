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
import { pageBoxMm, pageMm } from '@/modules/accounting/services/packs/pages/packPageMetrics';
import {
  brightsphereInput,
  brightsphereLiveInput,
  brightspherePriorInput,
  brightsphereSet,
  demoInput,
  demoSet,
  figures,
  noRatioPanelsInput,
  pageWithTableRow,
  trend,
} from './fixtures/boardPackInputs';
import { liveDemoRenderedInput } from './fixtures/liveDemoBoardPack';
import { OMISSION_MARK } from '@/modules/accounting/services/packs/pages/packPageFit';


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

  /**
   * SAYS SOMETHING ABOUT REVENUE BELOW ZERO, AS IT DOES ABOUT ASSETS.
   *
   * Brightsphere's pack heads its income statement with revenue of (5 535)
   * and puts the same figure on a highlights tile, with no callout anywhere,
   * while a negative asset side two sheets later gets a full explanatory
   * block. Negative turnover is at least as likely to be a posting error and
   * more consequential — every margin in the pack divides by it — so a page
   * that explains the one and stays silent on the other reads as though the
   * silent one is normal.
   */
  it('explains every income statement line below zero, not only revenue', () => {
    expect(brightsphereInput.set.current.revenue, 'this fixture is the negative-revenue case')
      .toBeLessThan(0);
    expect(demoInput.set.current.revenue, 'and this one is not').toBeGreaterThan(0);

    const income = (input: typeof demoInput) =>
      buildBoardPackPages(input).pages.find((p) => p.number === 6)!;

    const disclosed = income(brightsphereInput).blocks.find(
      (b) => b.kind === 'disclosure' && b.disclosure.heading === 'Lines below zero',
    );
    expect(disclosed, 'no block on the income statement explains negative turnover').toBeDefined();
    expect(disclosed?.kind === 'disclosure' && disclosed.disclosure.required)
      .toBe(true);
    const body = disclosed?.kind === 'disclosure' ? disclosed.disclosure.notes[0]?.body ?? '' : '';
    expect(body).toContain('in net debit');
    // AND EVERY OTHER LINE THE WRONG SIDE OF ZERO, which is the half this
    // block used to leave to the matters page eleven sheets later. The check
    // is read off the table, so every negative income or cost row on the
    // sheet has to be named in it.
    const page6 = income(brightsphereInput);
    const table = page6.blocks.find((b) => b.kind === 'table');
    const negatives = table?.kind === 'table'
      ? table.table.rows.filter((r) => r.role === 'line' && (r.figures.actual?.value ?? 0) < 0)
      : [];
    expect(negatives.length, 'this fixture has no negative line beyond revenue').toBeGreaterThan(1);
    for (const row of negatives) {
      // Case-insensitive on the LABEL, not on the body: the sentence sets its
      // first line in sentence case and the rest lower, and a `toContain` on
      // the lowered label would pass on "divides by revenue" three clauses
      // later — a match anywhere is not a match on the list.
      const listed = new RegExp(`${row.label}\\s+(is|are)?\\s*\\(`, 'i').test(body);
      expect(listed, `${row.label} is below zero and is not in the sheet's list: ${body}`).toBe(true);
    }

    // And only where it applies — a caveat printed on every pack is furniture.
    expect(income(demoInput).blocks.some(
      (b) => b.kind === 'disclosure' && b.disclosure.heading === 'Lines below zero',
    )).toBe(false);
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

  /**
   * SHEET 6 PRINTS ONE LINE TWICE, WITH TWO SIGNS, AND BOTH ARE RIGHT.
   *
   * The table states operating expenses as the ledger carries them — 226 —
   * and the bridge six centimetres below draws the same line as (226),
   * because a bridge bar is a STEP: how much that line moved the running
   * total. On Brightsphere it inverts, because operating expenses there are a
   * net CREDIT, so the bar reads 3 717 against a table cell of (3 717) and
   * the chart appears to state the opposite sign to the table on the same
   * sheet. Nothing on the page said which was which.
   */
  it('explains the one line whose bridge bar and table cell carry opposite signs', () => {
    for (const [name, input] of [['demo', demoInput], ['brightsphere', brightsphereInput]] as const) {
      const page = buildBoardPackPages(input).pages.find((p) => p.navLabel === 'Income statement')!;
      const note = page.footnotes.map((f) => f.text).join(' ');
      // BOTH RULES, because the bar is drawn by two of them: the sheet said
      // only that each bar is drawn by its effect on net profit, while the
      // colour keys off the line's class — which on a company with negative
      // revenue puts a green bar below the axis under a footnote a reader
      // can only take as promising the opposite.
      expect(note, `${name} does not say how the bridge is positioned`)
        .toMatch(/POSITIONS each bar by its effect on net profit/);
      expect(note, `${name} does not say how the bridge is coloured`)
        .toMatch(/COLOURS it by what the line is: green for income, red for cost/);
      // It NAMES a line and both of its figures, so a reader can check the
      // rule against the page rather than take it on trust — and the line it
      // names is one the table on that page actually carries.
      const named = /ran\. (.+) of .+ in the table is labelled with/.exec(note)?.[1];
      expect(named, 'the footnote names no line').toBeDefined();
      const rows = page.blocks.flatMap((b) => (b.kind === 'table' ? b.table.rows.map((r) => r.label.toLowerCase()) : []));
      expect(rows).toContain(named!.toLowerCase());
    }

    // And the footnotes are numbered in sequence — the note is conditional,
    // so the one after it cannot assume a fixed position.
    const page = buildBoardPackPages(demoInput).pages.find((p) => p.navLabel === 'Income statement')!;
    expect(page.footnotes.map((f) => f.number)).toEqual(
      page.footnotes.map((_, index) => index + 1),
    );
  });

  /**
   * AND THE INK THE FOOTNOTE NAMES IS THE INK THE BAR IS DRAWN IN.
   *
   * The sentence tells a director that the named line is green because it is
   * an income line, or red because it is a cost line. That is a claim about
   * the picture beside it, so it is checked against the picture's own model
   * rather than against a second copy of the rule.
   */
  it('names the colour the bar it points at is actually drawn in', () => {
    for (const [name, input] of [['demo', demoInput], ['brightsphere', brightsphereInput]] as const) {
      const page = buildBoardPackPages(input).pages.find((p) => p.navLabel === 'Income statement')!;
      const note = page.footnotes.map((f) => f.text).join(' ');
      const named = /ran\. (.+) of .+ in the table is labelled with|ran\. (.+) is drawn in/.exec(note);
      expect(named, `${name}: the footnote names no line`).not.toBeNull();
      const label = (named![1] ?? named![2])!;
      const ink = /is drawn in (green|red)|and in (green|red), because/.exec(note);
      expect(ink, `${name}: the footnote names no ink`).not.toBeNull();
      const word = (ink![1] ?? ink![2])!;

      const bar = page.blocks.flatMap((b) => (b.kind === 'chart' ? b.chart.waterfallBars ?? [] : []))
        .find((b) => b.label === label);
      expect(bar, `${name}: the footnote names a line the bridge does not draw`).toBeDefined();
      expect(bar!.paint, `${name}: the sheet describes ink the bar was not given`)
        .toBe(word === 'green' ? 'favourable' : 'unfavourable');
      // Every movement bar carries its class, or the next footnote to read
      // one would be describing an absence.
      const movements = page.blocks
        .flatMap((b) => (b.kind === 'chart' ? b.chart.waterfallBars ?? [] : []))
        .filter((b) => b.kind === 'increase' || b.kind === 'decrease');
      expect(movements.length).toBeGreaterThan(0);
      expect(movements.every((b) => b.paint !== undefined), `${name}: a bar carries no class`).toBe(true);
    }
  });

  it('turns no sheet sideways — twelve portrait pages', () => {
    // The trends page was the one landscape sheet, for six panels three
    // across. Two across at 83mm fits the portrait measure, and the taller
    // box is what three of its panels needed to show any movement.
    expect(doc.pages.filter((p) => p.orientation === 'landscape')).toHaveLength(0);
    expect(doc.pages.every((p) => p.orientation === 'portrait')).toBe(true);
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

  // PAGES 6, 7 AND 8 — not 5. Page 5's table has rows that are MONTHS, so it
  // has no comparative period to carry a column for; the reason it stopped
  // being a comparative statement is in `packMonthlyResults.ts`.
  it('carries the prior column on the statement tables when there is a prior period', () => {
    for (const n of [6, 7, 8]) {
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

    // PAGE 6. It was page 5 until that sheet stopped being a comparative
    // statement; the assertion is the same one — a cell read against the
    // header above it — on the first table in the pack that still has an
    // `actual` column with a line called Revenue in it.
    const table = doc.pages.find((p) => p.number === 6)!.blocks
      .flatMap((b) => (b.kind === 'table' ? [b.table] : []))[0]!;
    expect(table.scale).toBe(doc.numberConvention.scale);

    const revenue = table.rows.find((r) => r.label === 'Revenue')!.figures.actual!;
    expect(revenue.value).toBe(4_200_000);
    expect(formatFigureText(revenue, scale!)).toBe('4\u00a0200');
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

  it('draws the trends page as LINE panels tall enough to show a movement', () => {
    const panels = doc.pages.find((p) => p.number === 10)!.blocks
      .flatMap((b) => (b.kind === 'smallMultiples' ? b.panels : []));
    expect(panels.length).toBeGreaterThan(0);
    expect(panels.every((p) => p.kind === 'line')).toBe(true);
    // 36mm was what six panels three across cost on a landscape sheet whose
    // content box is 168mm rather than 255. Portrait and two across, three
    // rows of 44mm plus their gutters come to 148mm in a 255mm box — a fifth
    // more height to draw in, and 12mm of headroom for the page's two
    // disclosures. It is BELOW §5.6's 48mm inline rung deliberately: this is
    // the only page carrying three rows of charts, and at 48 the live demo
    // page measured 255.8mm in a 255mm box and dropped a disclosure to pay
    // for the 0.8. The sheet count in tests/unit/print/packSheetCount.test.ts
    // is what actually holds this.
    // 30, DOWN FROM 37.6, AND THE PAGE'S TWO NOTES ARE WHAT IT BUYS. A PANEL's
    // `heightMm` is its PLOT BOX and its caption is charged on top of it, so
    // once every panel's axis printed its own low and high and the two ratio
    // panels said which scale they are on, six panels at 37.6 measured
    // 267.2mm in a 255mm box and `fitPageToBox` took BOTH notes from "Reading
    // these panels" — on the one page whose own claims those notes make
    // checkable. At 30 the same page measures 244.4mm and drops nothing. The
    // 10mm left over is not slack: a caption that wraps grows its row, and
    // these captions now carry an "Own scale" clause.
    //
    // 28, DOWN FROM 30, AND THE PART-MONTH MARKER IS WHAT IT BUYS. Naming the
    // terminal month inside each panel's own movement sentence — required
    // where that month is a seven-day stub, see `packPartialMonth.ts` — costs
    // one caption line on the tallest panel of each of the three rows, 4.2mm,
    // on a page that measured 254.9mm in a 255mm box. Two millimetres a row
    // is where it comes from, and the alternative was the page's two "Reading
    // these panels" notes.
    expect(panels.every((p) => p.heightMm === 28)).toBe(true);
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
  it('agrees with the figure beside it in the titles of pages 3 and 6', () => {
    const noOperatingLine = buildBoardPackPages({
      ...demoInput,
      set: { ...demoSet, current: figures({ operatingProfit: undefined }) },
    });
    const tile = noOperatingLine.pages.find((p) => p.number === 3)!.blocks
      .flatMap((b) => (b.kind === 'kpiTiles' ? b.tiles : []))
      .find((t) => t.label === 'Operating profit')!;
    // PAGE 6 CARRIES THE OPERATING PROFIT ROW NOW. Page 5's table is months,
    // not lines, and its title states the spread of net profit across them —
    // which is asserted against its own table below.
    const row = noOperatingLine.pages.find((p) => p.number === 6)!.blocks
      .flatMap((b) => (b.kind === 'table' ? b.table.rows : []))
      .find((r) => r.label === 'Operating profit')!;

    expect(tile.figure.value).not.toBeNull();
    expect(row.figures.actual!.value).toBe(tile.figure.value);

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

/**
 * THE COMPANY THAT COULD NOT PRINT A BOARD PACK AT ALL.
 *
 * Brightsphere's live pack composed twelve sheets, then stopped composing
 * anything: `fitPageToBox` refused its scorecard at 264.9mm on a 255mm sheet
 * and the download returned 422. The refusal was right — the page really did
 * not fit — and what did not fit was seven not-meaningful notes printed twice,
 * once plainly for the current period and once again prefixed "In the
 * comparative period: " for a comparative in which the same sentence is just
 * as true. See `packScorecard.ts`.
 */
describe('Brightsphere, with the comparative period the live tenant has', () => {
  it('composes its twelve pages', () => {
    expect(() => buildBoardPackPages(brightspherePriorInput)).not.toThrow();
  });

  it('fits its scorecard on one sheet, with room to spare', () => {
    const scorecard = buildBoardPackPages(brightspherePriorInput)
      .pages.find((page) => page.navLabel === 'Scorecard');

    expect(scorecard).toBeDefined();
    expect(pageMm(scorecard!)).toBeLessThan(pageBoxMm(scorecard!));
  });
});

/**
 * THE SAME COMPANY, THREE WEEKS LATER, REFUSED ON A DIFFERENT SHEET.
 *
 * `fitPageToBox: "Income statement" needs 260.5mm and its sheet gives 255mm,
 * with nothing left on it that may be dropped` — the live route, on the
 * ledger `brightsphereLiveInput` is read off. Nothing on that sheet is spare:
 * the table and the bridge carry figures, the caption is derived, the
 * negative-revenue disclosure is required and its single note may not be
 * taken, and the sign-flip footnote is the only thing on the page explaining
 * why the table states operating expenses as (3.717) and the bridge draws
 * 3.717.
 *
 * So the chart pays, because the chart is the one block on the page whose
 * height the spec lets the pack choose, and it is chosen by MEASURING the
 * composed page rather than by predicting what will be on it — see
 * `shorterProfitBridge`. Mutation: force the bridge to keep the rung
 * `buildProfitWaterfallChart`'s predicates picked and this file refuses to
 * compose the pack at all, at exactly the 260.5mm the live route reported.
 */
describe('Brightsphere as the live route composed it', () => {
  // Composed inside each case rather than once at describe scope: the failure
  // this pins is a THROW, and a throw during collection takes the whole file
  // down with it instead of naming the case that found it.
  const incomeStatement = () => buildBoardPackPages(brightsphereLiveInput)
    .pages.find((page) => page.navLabel === 'Income statement')!;

  it('composes twelve sheets rather than refusing the pack', () => {
    expect(buildBoardPackPages(brightsphereLiveInput).pages).toHaveLength(12);
  });

  it('fits its income statement on one sheet', () => {
    const income = incomeStatement();
    expect(pageMm(income)).toBeLessThanOrEqual(pageBoxMm(income));
  });

  it('keeps the note reconciling the table\'s sign with the bridge\'s', () => {
    const income = incomeStatement();
    expect(income.footnotes.some((f) => f.required === true && /same fact read two ways/.test(f.text)))
      .toBe(true);
    // And it did not buy the space by abridging the disclosure either.
    expect(income.blocks.some((b) => b.kind === 'disclosure'
      && b.disclosure.heading === 'Lines below zero'
      && b.disclosure.notes.length === 1)).toBe(true);
    // Nor by apologising for its own layout.
    expect(income.footnotes.some((f) => f.text.startsWith(OMISSION_MARK))).toBe(false);
  });

  it('pays for the room out of the bridge, and takes back what the ladder overshot', () => {
    // IT WAS 48 — THE BOTTOM RUNG — AND THAT WAS THE DEFECT, NOT THE RULE.
    // The ladder steps 110 → 72 → 48 and the decision it answers is measured
    // in tenths: this sheet missed the 72mm rung by 0.2mm and printed a 48mm
    // bridge with 23.8mm of white under it, while the demo drew the same
    // chart at 72. The ladder still chooses the rung; the page is then grown
    // back into the paper it actually has.
    const page = incomeStatement();
    const chart = page.blocks.flatMap((b) => (b.kind === 'chart' ? [b.chart] : []))[0]!;
    expect(chart.id).toBe('profit-bridge');
    expect(chart.heightMm, 'the bridge is back on the bottom rung with paper under it')
      .toBeGreaterThan(48);
    // And it took only what was there: the sheet still fits.
    expect(pageMm(page)).toBeLessThanOrEqual(pageBoxMm(page));
    // Whole millimetres — the spare is a difference of two measured heights.
    expect(chart.heightMm).toBe(Math.floor(chart.heightMm));
  });

  /**
   * PAGE 8'S CHART IS SIZED BY THE SHEET IT IS ON, the way page 6's is.
   *
   * It was a fixed 36mm, chosen when this page also carried a cash bridge and
   * was printing on two sheets. On a company with no bridge to draw the page
   * then ended at two thirds of the paper with its only picture of cash in a
   * band under half the plot depth of the two charts before it.
   */
  it('gives page 8 the tallest cash line the sheet has room for', () => {
    const cash = buildBoardPackPages(liveDemoRenderedInput)
      .pages.find((page) => page.navLabel === 'Cash')!;
    const line = cash.blocks.flatMap((b) => (b.kind === 'chart' ? [b.chart] : []))
      .find((c) => c.id === 'cash-trend')!;
    // On the height grid, and not on the bottom of it: this page draws no
    // bridge, so there is nothing for the line to give height back to.
    expect([110, 72, 48]).toContain(line.heightMm);
    // A rung taller would not fit — which is what makes this the tallest and
    // not merely a bigger constant.
    expect(pageMm(cash)).toBeLessThanOrEqual(pageBoxMm(cash));
    expect(cash.footnotes.some((f) => f.text.startsWith(OMISSION_MARK))).toBe(false);
  });

  it('steps the cash line down where the sheet also carries a bridge', () => {
    // The dense fixture's page 8 carries a cash bridge, two disclosures and a
    // five-row table with four footnotes. The line is the one thing on it
    // with a height to give, and it must not be bought with the sentence
    // saying part of the movement is unexplained.
    const cash = buildBoardPackPages(demoInput).pages.find((page) => page.navLabel === 'Cash')!;
    const charts = cash.blocks.flatMap((b) => (b.kind === 'chart' ? [b.chart] : []));
    const line = charts.find((c) => c.id === 'cash-trend');
    if (line !== undefined) {
      expect(line.heightMm).toBeLessThanOrEqual(48);
      expect(pageMm(cash)).toBeLessThanOrEqual(pageBoxMm(cash));
    }
    expect(cash.footnotes.some((f) => f.text.startsWith(OMISSION_MARK))).toBe(false);
  });

  it('never measures a page down further than it needs, and never past the tallest rung', () => {
    // The live demo company's sheet fits at the 72mm rung, so nothing steps
    // it down — and it then grows into the paper below it, capped at the
    // tallest rung the spec allows.
    const demoIncome = buildBoardPackPages(liveDemoRenderedInput)
      .pages.find((page) => page.navLabel === 'Income statement')!;
    const chart = demoIncome.blocks.flatMap((b) => (b.kind === 'chart' ? [b.chart] : []))[0]!;
    expect(chart.heightMm).toBeGreaterThanOrEqual(72);
    expect(chart.heightMm, 'the bridge grew past the tallest rung the spec states')
      .toBeLessThanOrEqual(CHART_HEIGHT_MM.full);
    expect(pageMm(demoIncome)).toBeLessThanOrEqual(pageBoxMm(demoIncome));
  });
});
