/**
 * HOW A RATIO IS NAMED AND WRITTEN.
 */
import { describe, expect, it } from 'vitest';
import {
  formatRatioFigure, ratioLabel, ratioLine, ratioLines, UnknownRatioError,
} from '@/modules/accounting/services/reports/ratioPresentation';
import { calculateExtendedRatios } from '@/modules/accounting/services/reports/reportingEngineService';
import { buildReportPack } from '@/modules/accounting/services/reports/reportPackService';
import { buildPackDocument } from '@/modules/accounting/services/packs/packDocument';

describe('a margin or a return is a LEVEL, and a level carries no plus sign', () => {
  // The "+" belongs to a CHANGE: "+4.0%" says something rose. A gross margin
  // of 45% did not rise by 45%, and "+45.0%" on a ratio list reads as growth.
  it('writes a positive level unsigned', () => {
    expect(formatRatioFigure('pct', 45)).toBe('45.0%');
    expect(formatRatioFigure('pct', 0)).toBe('0.0%');
  });

  it('writes a negative level in the pack\'s brackets', () => {
    expect(formatRatioFigure('pct', -107.5)).toBe('(107.5%)');
  });

  it('prints every percentage ratio of a real result unsigned', () => {
    const lines = ratioLines(calculateExtendedRatios({
      revenue: 1_000_000, costOfSales: 600_000, operatingExpenses: 250_000, netProfit: 100_000,
      totalAssets: 2_000_000, totalLiabilities: 800_000, totalEquity: 1_200_000,
      currentAssets: 900_000, currentLiabilities: 450_000,
      inventory: 150_000, accountsReceivable: 200_000, accountsPayable: 120_000, cash: 300_000,
    }) as unknown as Record<string, unknown>);
    const percentages = lines.filter((l) => l.stated && l.text.endsWith('%'));
    expect(percentages.length).toBeGreaterThan(5);
    expect(percentages.filter((l) => l.text.startsWith('+'))).toEqual([]);
    expect(lines.find((l) => l.key === 'grossProfitMargin')!.text).toBe('40.0%');
  });
});

describe('a ratio the table does not know fails closed', () => {
  // The table is a `satisfies Record<RatioKey, …>`, so a ratio added to the
  // engine without a row is a compile error. At run time a blob is
  // `Record<string, unknown>`: an unknown key used to be given a label split
  // on its capitals and two decimals, or dropped from the document — a new
  // ratio printing unlabelled in the wrong unit, or vanishing.
  it('refuses to name it', () => {
    expect(() => ratioLabel('returnOnInvestedCapital')).toThrow(UnknownRatioError);
    expect(() => ratioLabel('returnOnInvestedCapital')).toThrow(/returnOnInvestedCapital/);
  });

  it('refuses to print it', () => {
    expect(() => ratioLine('returnOnInvestedCapital', 12.5, {})).toThrow(UnknownRatioError);
    expect(() => ratioLine('returnOnInvestedCapital', null, {})).toThrow(/returnOnInvestedCapital/);
  });

  it('refuses a result that carries one, rather than printing the rest', () => {
    expect(() => ratioLines({ currentRatio: 2, returnOnInvestedCapital: 12.5, notMeaningful: {} }))
      .toThrow(/returnOnInvestedCapital/);
  });

  it('is refused by the pack document too, which used to drop the row', () => {
    const pack = buildReportPack('management', {
      companyName: 'Demo', period: 'p', revenue: 1000, costOfSales: 400, operatingExpenses: 200, netProfit: 400,
      totalAssets: 5000, totalLiabilities: 2000, totalEquity: 3000, currentAssets: 2500, currentLiabilities: 1000,
      cash: 800, accountsReceivable: 900, accountsPayable: 500, inventory: 100,
    }, '2026-01-01', '2026-08-31');
    const tampered = {
      ...pack,
      sections: pack.sections.map((s) => (s.type !== 'ratios' ? s : { ...s, data: { ...s.data, returnOnInvestedCapital: 12.5 } })),
    };
    expect(() => buildPackDocument(tampered, [])).toThrow(/returnOnInvestedCapital/);
    expect(() => buildPackDocument(pack, [])).not.toThrow();
  });

  it('still ignores what is not a ratio at all: the reasons map', () => {
    expect(ratioLines({ currentRatio: 2, notMeaningful: {} }).map((l) => l.key)).toEqual(['currentRatio']);
  });
});
