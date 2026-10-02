/**
 * NO HEADLINE, PANEL OR SPARKLINE COMPARES A WHOLE MONTH WITH A STUB.
 *
 * Velocity Fibre's pack ran to 2 October 2026, so the twelfth month of the
 * series covered two of October's thirty-one days, with no revenue posted in
 * them yet. Page 10's headline read "Revenue is down 100.0% from the first
 * month of the 12-month series to the last"; four panel titles ended "… in
 * Oct 2026 (part)", and page 3's sparklines dropped to nil at their right
 * edge. Each compared November's whole month with two days of October.
 *
 * THE CHOICE: the part month is left out of every start-to-end comparison —
 * page 10's panels and headline, and page 3's sparklines draw whole months
 * only — and page 10 says which month it left out. The alternative, defaulting
 * the to-date to the last month-end, fixes only the default: a director who
 * picks 2 October gets the same headline back. The part month stays where it
 * is a ROW rather than a comparison: page 5's table, marked "(part)".
 */
import { describe, expect, it } from 'vitest';
import { buildBoardPackPages, type BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { PackPage, PackPagesDocument } from '@/modules/accounting/services/packs/pages/packPageModel';
import { demoInput } from './fixtures/boardPackInputs';
import { monthlyResultsCaption } from '@/modules/accounting/services/packs/pages/packMonthlyCaption';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { velocityInput } from './fixtures/velocityBoardPack';

const pageNamed = (doc: PackPagesDocument, nav: string): PackPage => {
  const page = doc.pages.find((p) => p.navLabel === nav);
  expect(page, `no page called ${nav}`).toBeDefined();
  return page!;
};

function panelTitles(input: BoardPackInput): string[] {
  const block = pageNamed(buildBoardPackPages(input), 'Trends').blocks.find((b) => b.kind === 'smallMultiples');
  if (block === undefined || block.kind !== 'smallMultiples') throw new Error('page 10 draws no panels');
  return block.panels.map((panel) => panel.title);
}

function notesOf(page: PackPage): string[] {
  return page.blocks.flatMap((b) => (b.kind === 'disclosure' ? b.disclosure.notes.map((n) => `${n.heading}: ${n.body}`) : []));
}

describe('page 10 on a series that ends two days into October', () => {
  const doc = buildBoardPackPages(velocityInput);

  it('headlines November against September, the last whole month — up, not down 100.0%', () => {
    const title = pageNamed(doc, 'Trends').title;
    expect(title).not.toMatch(/100\.0%/);
    // 23 377 against 2 932.
    expect(title).toBe('Revenue is up 697.3% from the first month of the 11-month series to the last.');
  });

  it('ends no panel on the part month', () => {
    const titles = panelTitles(velocityInput);
    expect(titles.length).toBe(6);
    for (const title of titles) {
      expect(title).not.toMatch(/\(part\)|Oct 2026/);
    }
    expect(titles[0]).toMatch(/^Revenue rose from 2.932 to 23.377 over 11 periods\.$/);
  });

  it('says which month it left out, and why', () => {
    const period = notesOf(pageNamed(doc, 'Trends')).find((n) => n.startsWith('Period:'));
    expect(period).toMatch(/Oct 2026 is a part month and is not drawn/);
  });
});

describe('page 3\'s sparklines on the same series', () => {
  it('stop at the last whole month', () => {
    const block = pageNamed(buildBoardPackPages(velocityInput), 'Highlights').blocks.find((b) => b.kind === 'kpiTiles');
    if (block === undefined || block.kind !== 'kpiTiles') throw new Error('page 3 has no tiles');
    const drawn = block.tiles.filter((t) => t.sparklineWindow !== null);
    expect(drawn.map((t) => t.label)).toEqual(['Revenue', 'Gross margin', 'Net profit', 'Cash', 'Debtor days']);
    for (const tile of drawn) expect(tile.sparklineWindow!.of).toBe(11);
  });
});

describe('where the part month still prints', () => {
  it('is page 5\'s table, as a row marked part', () => {
    const page = pageNamed(buildBoardPackPages(velocityInput), 'Monthly results');
    expect(JSON.stringify(page.blocks)).toContain('Oct 2026 (part)');
    // …and the sheet says the row is on no panel, or "the window page 10
    // draws from" reads as a claim that October is drawn.
    const windowNote = notesOf(page).find((n) => n.startsWith('The window:'));
    expect(windowNote).toMatch(/Oct 2026 is a part month: it covers 2 of its 31 days, so .*page 10 does not draw it\./);
  });
});

describe('a series that ends on a whole month', () => {
  it('draws every month it has, as before', () => {
    // demoInput's thirteen months are all whole.
    expect(demoInput.trend.every((p) => !p.partial)).toBe(true);
    const titles = panelTitles(demoInput);
    expect(titles.some((t) => t.includes(`over ${demoInput.trend.length} periods`))).toBe(true);
    const period = notesOf(pageNamed(buildBoardPackPages(demoInput), 'Trends')).find((n) => n.startsWith('Period:'));
    expect(period).not.toMatch(/not drawn/);
  });
});

describe('page 5\'s headline, which ranks the months', () => {
  // A stub of two days with a month's rent posted on the 1st and no revenue
  // yet is not "the lowest month" — the same comparison page 10 no longer makes.
  const stubbed: BoardPackInput = {
    ...demoInput,
    trend: demoInput.trend.map((point, i, all) => (i === all.length - 1
      ? { ...point, partial: true, daysCovered: 2, revenue: 0, otherIncome: 0, costOfSales: 0, operatingExpenses: 150_000, expenses: 150_000, netProfit: -150_000 }
      : point)),
  };

  it('ranks whole months only, and says so', () => {
    const title = pageNamed(buildBoardPackPages(stubbed), 'Monthly results').title;
    expect(title).not.toContain('(part)');
    expect(title).toMatch(/across the 12 whole months\.$/);
  });

  it('is unchanged where every month is whole', () => {
    expect(pageNamed(buildBoardPackPages(demoInput), 'Monthly results').title).toMatch(/across the 13 months\.$/);
  });
});

describe('page 5\'s caption, which names the biggest month', () => {
  it('ranks whole months, and still totals the whole window', () => {
    // A two-day stub that invoices on the 1st: 900 000 of revenue.
    const input: BoardPackInput = {
      ...demoInput,
      trend: demoInput.trend.map((point, i, all) => (i === all.length - 1
        ? { ...point, partial: true, daysCovered: 2, revenue: 900_000 }
        : point)),
    };
    const caption = JSON.stringify(pageNamed(buildBoardPackPages(input), 'Monthly results').blocks);
    expect(caption).not.toMatch(/\(part\) carried the most revenue/);
    expect(caption).toMatch(/carried the most revenue of any whole month/);
  });
});

describe('page 5\'s caption on a window whose revenue is not a positive base', () => {
  it('names the largest WHOLE month as such where the stub out-earned it', () => {
    // Twelve whole months of (100) and a two-day stub of 200: the window is
    // (1 000). "The largest single month is M1" would be false — the stub is larger.
    const trend = demoInput.trend.map((point, i, all) => (i === all.length - 1
      ? { ...point, partial: true, daysCovered: 2, revenue: 200_000 }
      : { ...point, revenue: -100_000 }));
    const caption = monthlyResultsCaption(trend, PACK_SCALE);
    expect(caption).toContain('not a positive base');
    expect(caption).toMatch(/The largest single whole month is /);
  });
});

