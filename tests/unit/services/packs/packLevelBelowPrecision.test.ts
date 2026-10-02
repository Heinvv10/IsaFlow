/**
 * A MARGIN TOO SMALL FOR ONE DECIMAL IS NOT "NIL" IN A SENTENCE EITHER.
 *
 * Page 12 defines nil as a figure measured and nil. A gross margin of 0.043%
 * — revenue 2 311, cost of sales 2 310, in R'000 — printed "Gross margin is
 * nil on revenue of 2 311": the prose twin of the cash ratio printed as the
 * nil dash. A real level below its precision is stated as a bound, with its
 * direction; a measured zero is still nil.
 */
import { describe, expect, it } from 'vitest';
import { pctLevelWithWord } from '@/lib/format/pctLevelWithWord';
import { buildBoardPackPages } from '@/modules/accounting/services/packs/pages/boardPackPages';
import { positionCaption } from '@/modules/accounting/services/packs/narrative/derivedCaptions';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import { demoInput, demoSet, figures } from './fixtures/boardPackInputs';

describe('a percentage level in a sentence', () => {
  it('states a real level below one decimal as a bound with its direction', () => {
    expect(pctLevelWithWord(0.043, 'a positive', 'a negative')).toBe('a positive <0.1%');
    expect(pctLevelWithWord(-0.043, 'a positive', 'a negative')).toBe('a negative <0.1%');
  });

  it('is nil only where it measured nil, and a figure where it has one', () => {
    expect(pctLevelWithWord(0, 'a positive', 'a negative')).toBe('nil');
    expect(pctLevelWithWord(0, 'at', 'at negative', 'at nil')).toBe('at nil');
    expect(pctLevelWithWord(26.8, 'a positive', 'a negative')).toBe('a positive 26.8%');
    expect(pctLevelWithWord(-4, 'a positive', 'a negative')).toBe('a negative 4.0%');
  });
});

describe('page 6 on a margin of 0.043%', () => {
  it('does not call it nil', () => {
    const current = figures({
      revenue: 2_311_000, costOfSales: 2_310_000, operatingProfit: -1_139_000, netProfit: -1_154_000,
    });
    const doc = buildBoardPackPages({ ...demoInput, set: { ...demoSet, current } });
    const title = doc.pages.find((p) => p.navLabel === 'Income statement')!.title;
    expect(title).toMatch(/^Gross margin is a positive <0\.1% on revenue of 2.311\.$/);
  });
});

describe('the other level sentences', () => {
  const textOf = (input: Parameters<typeof buildBoardPackPages>[0], nav: string): string => {
    const page = buildBoardPackPages(input).pages.find((p) => p.navLabel === nav)!;
    return `${page.title}\n${JSON.stringify(page.blocks)}`;
  };

  it('page 3 states an operating margin below one decimal as a bound', () => {
    const current = figures({ operatingProfit: 1_000, netProfit: 1_000 - 15_000 - 42_000 - 181_000 });
    expect(textOf({ ...demoInput, set: { ...demoSet, current } }, 'Highlights'))
      .toContain('Operating margin is a positive <0.1%.');
  });

  it('page 7\'s caption states a current-asset cover below one decimal as a bound', () => {
    // 400 over 940 000 is 0.043%: below one decimal.
    const current = figures({ currentAssets: 400 });
    expect(positionCaption({ ...demoSet, current }, PACK_SCALE))
      .toMatch(/^Current assets cover current liabilities at <0\.1% — a current ratio of <0\.01×/);
  });
});

