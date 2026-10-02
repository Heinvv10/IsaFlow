/**
 * A MARGIN OR A CHANGE THAT ROUNDS TO NOTHING HAS NO DIRECTION.
 *
 * `pctWithWord` names the sign with a word, and the board passed it no word
 * for nil, so a zero margin printed "a positive 0.0%" and a change of 0.04%
 * "up 0.0%" — a direction the printed digits do not carry. Each sentence
 * now names its nil: a margin "is nil", a cover is "at nil", and a change
 * is "unchanged" (the tile, where the line has no room for a verb, "flat on").
 */
import { describe, expect, it } from 'vitest';
import { PACK_SCALE } from '@/modules/accounting/services/packs/pages/packBasis';
import {
  cashTitle,
  highlightsTitle,
  incomeStatementTitle,
  positionTitle,
  tileCaption,
} from '@/modules/accounting/services/packs/narrative/derivedSentences';
import { positionCaption } from '@/modules/accounting/services/packs/narrative/derivedCaptions';
import { trendsTitle } from '@/modules/accounting/services/packs/narrative/derivedTrendsTitle';
import type { PackKpiTile } from '@/modules/accounting/services/packs/pages/packPageModel';

const current = { revenue: 1_000_000, costOfSales: 1_000_000, operatingExpenses: 0, otherIncome: 0, operatingProfit: 0, totalEquity: 1_000_400, cash: 200_050, currentAssets: 0, currentLiabilities: 500_000 };
const prior = { revenue: 999_700, costOfSales: 400_000, operatingExpenses: 0, otherIncome: 0, operatingProfit: 0, totalEquity: 1_000_000, cash: 200_000, currentAssets: 0, currentLiabilities: 500_000 };
const set = { current, prior } as never;

const tile = (value: number, unit: 'percent' | 'points'): PackKpiTile => ({
  label: 'Revenue',
  figure: { value: 1_000_000, format: 'money', source: 't.v' },
  delta: { value, unit, basis: 'prior period', favourable: value > 0 },
  deltaAbsence: null,
} as unknown as PackKpiTile);

describe('nil margins and changes on the board pack', () => {
  it('a margin of exactly nil is nil, not "a positive 0.0%"', () => {
    expect(incomeStatementTitle(set, PACK_SCALE)).toMatch(/^Gross margin is nil on revenue of /);
    expect(highlightsTitle(set, PACK_SCALE)).toMatch(/Operating margin is nil\.$/);
  });

  it('a cover of nil is "at nil"', () => {
    expect(positionCaption(set, PACK_SCALE)).toMatch(/^Current assets cover current liabilities at nil — /);
  });

  it('a change that rounds to 0.0% is unchanged, and the sentence still reads', () => {
    expect(highlightsTitle(set, PACK_SCALE)).toMatch(/^Revenue unchanged against the prior period\./);
    expect(positionTitle(set, PACK_SCALE)).toMatch(/^Equity is unchanged at /);
    expect(cashTitle(set, PACK_SCALE)).toMatch(/^Cash is unchanged at /);
    const trend = [{ revenue: 1_000 }, { revenue: 1_000.2 }] as never;
    expect(trendsTitle(trend, 'R' as never, 5)).toMatch(/^Revenue is unchanged from the first month/);
  });

  it('a tile whose movement rounds to nil says so, and calls it neither favourable nor unfavourable', () => {
    expect(tileCaption(tile(0.04, 'percent'))).toBe('Unchanged on the prior period.');
    expect(tileCaption(tile(-0.02, 'points'))).toBe('Unchanged on the prior period.');
    expect(tileCaption(tile(1.25, 'percent'))).toBe('Up 1.3% on the prior period — a favourable movement.');
  });
});
