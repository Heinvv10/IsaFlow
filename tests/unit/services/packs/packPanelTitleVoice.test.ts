/**
 * SIX PANEL TITLES, ONE VOICE.
 *
 * Brightsphere's page 10 read "Revenue: nil in the first month and Sep 2026
 * (part) of the 12-month series." for three of its four panels and
 * "Cash fell from (267) to (3 453) …" for the fourth — a colon-caption beside
 * a sentence, with nothing on the sheet saying the template had switched, and
 * the page's own title rendering the same flat series as a sentence. All six
 * of the demo's are sentences.
 *
 * The colon existed to dodge subject-verb agreement: "Operating expenses IS
 * nil" reads as a template that was never told whether its subject is plural.
 * The moving form never had that problem because "rose" and "fell" are past
 * tense, which does not inflect for number — and neither does "stayed".
 */
import { describe, expect, it } from 'vitest';
import { movementSentence } from '@/modules/accounting/services/packs/pages/packTrendScale';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import type { BoardPackInput } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { brightsphereLiveInput } from './fixtures/boardPackInputs';
import { liveDemoShortPanelsInput } from './fixtures/liveDemoBoardPack';

const COMPANIES: Record<string, BoardPackInput> = {
  'the demo company': liveDemoShortPanelsInput,
  Brightsphere: brightsphereLiveInput,
};

function panelTitles(input: BoardPackInput): string[] {
  return buildBoardPackPages(input).pages
    .flatMap((p) => p.blocks)
    .flatMap((b) => (b.kind === 'smallMultiples' ? b.panels.map((x) => x.title) : []));
}

describe('every trends panel is captioned the same way', () => {
  for (const [company, input] of Object.entries(COMPANIES)) {
    it(`writes no colon-caption on ${company}`, () => {
      const titles = panelTitles(input);
      expect(titles.length, 'this pack draws no panels, so nothing is captioned').toBeGreaterThan(0);
      for (const title of titles) {
        // A measure name followed by a colon is the label voice; every other
        // title on the sheet is a sentence about a movement.
        expect(title, `a colon-caption beside sentences: ${title}`).not.toMatch(/^[^.]{0,30}: /);
      }
    });
  }

  it('is not vacuous — one company has equal endpoints to caption', () => {
    // Brightsphere's revenue, operating expenses and net profit are nil in
    // both the first and the last month of its window; that is the shape that
    // took the other template.
    const equal = panelTitles(brightsphereLiveInput)
      .filter((t) => /stayed at|opened and closed at/.test(t));
    expect(equal.length, 'no equal-endpoint panel on either fixture, so the branch is untested')
      .toBeGreaterThan(0);
  });

  /**
   * AND "START EQUALS END" IS NOT "FLAT" — the defect the first version of
   * this branch shipped. Brightsphere's revenue is nil in the first month and
   * nil in the last and (5 535) in April, so three of its four panels said the
   * series "stayed at nil" above a line plunging to the axis floor, three
   * centimetres under a page title printing the excursion.
   */
  it('never says a series stayed still when its own line moves', () => {
    const trend = brightsphereLiveInput.trend;
    for (const [name, pick] of [
      ['Revenue', (p: typeof trend[number]) => p.revenue],
      ['Operating expenses', (p: typeof trend[number]) => p.expenses],
      ['Net profit', (p: typeof trend[number]) => p.netProfit],
    ] as const) {
      const values = trend.map(pick);
      const moved = values.some((v) => v !== values[0]);
      const title = panelTitles(brightsphereLiveInput).find((t) => t.startsWith(name));
      if (title === undefined) continue;
      if (!moved) continue;
      expect(title, `${name} moved and its panel says it stayed: ${title}`)
        .not.toMatch(/stayed at/);
      // And it says WHERE it went, from the series the panel plots.
      expect(title, `${name} moved and its panel does not say how far`).toMatch(/reaching /);
    }
  });

  it('agrees with a plural subject as readily as a singular one', () => {
    // The reason the colon was there. Past tense does not inflect for number,
    // so one word serves both.
    expect(movementSentence('Revenue', 'nil', 'nil', 12, true, 'Sep 2026 (part)'))
      .toBe('Revenue stayed at nil from the first month to Sep 2026 (part), over 12 periods.');
    expect(movementSentence('Operating expenses', 'nil', 'nil', 12, true))
      .toBe('Operating expenses stayed at nil from the first month to the last month, over 12 periods.');
    // And the moving form is untouched.
    expect(movementSentence('Cash', '(267)', '(3 453)', 12, false, 'Sep 2026 (part)'))
      .toBe('Cash fell from (267) to (3 453) in Sep 2026 (part) over 12 periods.');
  });
});
