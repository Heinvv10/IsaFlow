/**
 * THE COMMENTARY WRITES ITS FIGURES THE WAY THE REST OF THE PACK DOES.
 *
 * The management pack's commentary (page 11) read "reported revenue of
 * R -5 535 000" on Brightsphere and "a net profit margin of -1523%" on the
 * demo company: a hyphen for a minus in a pack whose notation page says no
 * minus sign is used, "R -" where every table brackets, no cents where every
 * table carries them, and a margin rounded to a whole percent beside a ratios
 * page printing "(1 522.9%)".
 *
 * Money goes through `formatMoney` with the pack's notation; a percentage in
 * a sentence carries its direction in a WORD (`pctWithWord`, the board pack's
 * own prose rule — "Gross margin is a negative 12.0%"), because a bracket in
 * running text reads as an aside. A margin on non-positive revenue is not
 * stated at all. Driven through the real pack service.
 */
import { describe, expect, it } from 'vitest';
import { buildReportPack, NO_MARGIN_SENTENCE, type ReportPackInput } from '@/modules/accounting/services/reports/reportPackService';

const BASE: ReportPackInput = {
  companyName: 'ISAFlow Demo (Pty) Ltd', period: '2026-01-01 to 2026-09-07',
  revenue: 101_400, costOfSales: 1_430_581.6, operatingExpenses: 215_059.3, netProfit: -1_544_240.9,
  totalAssets: 900_000, totalLiabilities: 1_300_000, totalEquity: -400_000,
  currentAssets: 140_000, currentLiabilities: 1_000_000, cash: 20_000,
  accountsReceivable: 58_000, accountsPayable: 300_000, inventory: 0,
};

const summary = (input: Partial<ReportPackInput>): string => {
  const pack = buildReportPack('management', { ...BASE, ...input }, '2026-01-01', '2026-09-07');
  return String(pack.sections.find((s) => s.type === 'commentary')!.data.summary).replace(/[  ]/g, ' ');
};

describe('the commentary on a loss', () => {
  const text = summary({});

  it('states revenue with grouping and cents, as the tables do', () => {
    expect(text).toContain('reported revenue of R 101 400.00.');
  });

  it('states the negative margin as a word and a level to one decimal', () => {
    expect(text).toContain('Net profit margin is a negative 1 522.9%.');
  });

  it('carries no minus sign and no whole-percent rounding', () => {
    expect(text).not.toMatch(/[-−]\s?\d/);
    expect(text).not.toMatch(/1523%/);
  });
});

describe('the commentary on negative revenue (Brightsphere)', () => {
  const text = summary({ companyName: 'Brightsphere Technologies (Pty) Ltd', revenue: -5_535_000, costOfSales: 0, netProfit: -6_400_000 });

  it('brackets the negative revenue as every table does, symbol inside', () => {
    expect(text).toContain('reported revenue of (R 5 535 000.00).');
    expect(text).not.toMatch(/R -|[-−]5/);
  });

  it('states no margin at all, only that there is none', () => {
    expect(text).toContain(NO_MARGIN_SENTENCE);
    expect(text).not.toMatch(/\d%/);
  });
});

describe('the commentary on ordinary figures', () => {
  it('states a positive margin as such', () => {
    const text = summary({ revenue: 4_200_000.55, costOfSales: 2_310_000.1, netProfit: 668_288.25 });
    expect(text).toBe('ISAFlow Demo (Pty) Ltd reported revenue of R 4 200 000.55. Net profit margin is a positive 15.9%.');
  });

  it('says nil revenue in a word, not a dash, and states no margin', () => {
    const text = summary({ revenue: 0, costOfSales: 0, netProfit: -910_000 });
    expect(text).toBe(`ISAFlow Demo (Pty) Ltd reported revenue of nil. ${NO_MARGIN_SENTENCE}`);
  });
});
