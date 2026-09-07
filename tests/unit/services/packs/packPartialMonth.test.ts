/**
 * A SEVEN-DAY MONTH DRAWN AND QUOTED AS A FULL ONE.
 *
 * The reporting period of the rendered pack ended on 7 September 2026. "Sep
 * 2026" was the last row of sheet 5 and the terminal point of four panels on
 * sheet 10, with nothing anywhere marking it as part of a month, and it
 * produced this on a page going to directors:
 *
 *   "Gross margin fell from 5323.5% to 100.0% over 3 periods"
 *
 * 100.0% is those seven days: revenue of 30 and no cost of sales yet posted.
 * The same stub set the end of the revenue panel ("rose from nil to 30"), the
 * operating-expenses panel ("to 41") and the debtor-days panel ("to 59.6
 * days"), and it was summed into sheet 5's closing row beside eleven whole
 * months. The basis of preparation did not mention it at all.
 *
 * This holds the marking in BOTH directions: a mid-month pack marks the stub
 * everywhere it prints it, and a pack run to a month end marks nothing —
 * a "(part)" on a whole month would be the mirror defect.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { demoInput } from './fixtures/boardPackInputs';
import type { PackTrendPoint } from '@/modules/accounting/services/packs/packTrendService';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

/** The pack composed over a trend whose last month is (or is not) a stub. */
function pagesWith(partial: boolean) {
  const trend: PackTrendPoint[] = demoInput.trend.map((point, i, all) =>
    (i === all.length - 1
      ? { ...point, partial, daysCovered: partial ? 7 : 30, daysInMonth: 30 }
      : point));
  return buildBoardPackPages({ ...demoInput, trend });
}

/** Every string the composed document prints — titles, captions, notes,
 *  footnotes, table labels, chart titles, caveats. */
function printedText(doc: ReturnType<typeof buildBoardPackPages>): string {
  const out: string[] = [];
  for (const page of doc.pages) {
    out.push(page.title, ...page.footnotes.map((f) => f.text));
    for (const block of page.blocks) {
      if (block.kind === 'table') out.push(...block.table.rows.map((r) => r.label));
      if (block.kind === 'chart') out.push(block.chart.title);
      if (block.kind === 'smallMultiples') out.push(...block.panels.map((p) => p.title));
      if (block.kind === 'disclosure') {
        out.push(block.disclosure.heading, ...block.disclosure.notes.map((n) => n.body));
      }
      if (block.kind === 'narrative') out.push(...(block.narrative.paragraphs ?? []));
    }
  }
  return out.join('\n');
}

describe('a monthly series that ends on a part month', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks the row, the closing row and the panel terminals', () => {
    const text = printedText(pagesWith(true));
    const last = demoInput.trend[demoInput.trend.length - 1]!.label;
    // The row itself.
    expect(text).toContain(`${last} (part)`);
    // The closing row of sheet 5, which SUMS the stub into the window total.
    expect(text).toMatch(new RegExp(`\\d+ months to ${last} \\(part\\)`));
    // AND EVERY PANEL THAT ENDS ON IT NAMES IT INSIDE ITS OWN MOVEMENT
    // SENTENCE. "Revenue rose from nil to 30 over 12 periods" states a current
    // position measured over seven days; six panels' worth of a separate
    // explanatory sentence is 21mm page 10 does not have, so the marker rides
    // in the sentence and what it MEANS is stated once, on page 12.
    const named = text.match(new RegExp(`to [^.]+ in ${last} \\(part\\) over \\d+ periods`, 'g')) ?? [];
    expect(named.length, 'the panel titles do not name the part month').toBeGreaterThanOrEqual(4);
    // The page-8 cash line has the room for the full sentence and carries it.
    expect(text).toMatch(/is a part month: it covers 7 of its 30 days/);
  });

  it('states it in the basis of preparation, which said nothing about it', () => {
    // Read off the COMPOSED basis page, not off the model — `fitPageToBox`
    // drops prose silently when a page grows, and a caveat that is built and
    // then dropped discloses nothing.
    const basis = pagesWith(true).pages.find((p) => p.navLabel === 'Basis of preparation')!;
    const notes = basis.blocks.flatMap((b) =>
      (b.kind === 'disclosure' ? b.disclosure.notes.map((n) => n.body) : []));
    const caveat = notes.find((c) => /part month/i.test(c));
    expect(caveat, 'the basis page does not print the part-month caveat').toBeDefined();
    // It says the WINDOW, not merely that a month is short — a reader goes to
    // this page to find out what a figure was measured over.
    expect(caveat).toContain('7 of');
    expect(caveat).toContain('30 days');
  });

  /**
   * THE MIRROR. A guard that marks a whole month is the same defect written
   * the other way, and a pack run at a month end is the ordinary case.
   */
  it('marks nothing when the last month is whole', () => {
    const text = printedText(pagesWith(false));
    expect(text).not.toContain('(part)');
    expect(text).not.toMatch(/part month/i);
  });
});
