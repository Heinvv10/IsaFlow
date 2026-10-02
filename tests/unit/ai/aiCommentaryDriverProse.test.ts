/**
 * THE AI COMMENTARY'S KEY-DRIVER SENTENCES WRITE THEIR PERCENTAGES AS THE PACK DOES.
 *
 * `identifyKeyDrivers` wrote "Net Profit decreased by 1523.4%" with
 * `toFixed` — no grouping — and "remained flat by 0.4%", and on a prior of
 * nil "Revenue remained flat by 0.0%" for revenue that went from nothing to
 * a million. The change now goes through `pctWithWord` (grouped, one decimal,
 * its direction in the word), a flat line says only that, and a line with no
 * prior figure says it rose or fell from nil.
 */
import { describe, expect, it } from 'vitest';
import { identifyKeyDrivers, type ManagementPackData } from '@/modules/accounting/services/reports/aiCommentaryService';

type Lines = ManagementPackData['incomeStatement'];
const plain = (s: string): string => s.replace(/[  ]/g, ' ');

const PRIOR: Lines = { revenue: 100_000, costOfSales: 60_000, grossProfit: 40_000, operatingExpenses: 50_000, netProfit: 100_000 };
const CURRENT: Lines = { revenue: 101_400, costOfSales: 60_200, grossProfit: 41_200, operatingExpenses: 0, netProfit: -1_423_400 };

const explanation = (current: Lines, prior: Lines, metric: string): string =>
  plain(identifyKeyDrivers(current, prior).find((d) => d.metric === metric)!.explanation);

describe('the key-driver sentences', () => {
  it('group a large change and state it to one decimal', () => {
    expect(explanation(CURRENT, PRIOR, 'netProfit')).toBe('Net Profit decreased by 1 523.4%');
  });

  it('state a rise in a word', () => {
    expect(explanation(CURRENT, PRIOR, 'grossProfit')).toBe('Gross Profit increased by 3.0%');
  });

  it('say a fall to nil is a fall of 100.0%', () => {
    expect(explanation(CURRENT, PRIOR, 'operatingExpenses')).toBe('Operating Expenses decreased by 100.0%');
  });

  it('say a line within one percent remained flat, and quote no figure for it', () => {
    expect(explanation(CURRENT, PRIOR, 'costOfSales')).toBe('Cost of Sales remained flat');
  });

  it('say a line with no prior figure rose from nil, not that it remained flat', () => {
    expect(explanation({ ...CURRENT, revenue: 1_000_000 }, { ...PRIOR, revenue: 0 }, 'revenue')).toBe('Revenue increased from nil');
    expect(explanation({ ...CURRENT, netProfit: -5_000 }, { ...PRIOR, netProfit: 0 }, 'netProfit')).toBe('Net Profit decreased from nil');
  });

  it('carry no minus sign', () => {
    for (const d of identifyKeyDrivers(CURRENT, PRIOR)) expect(d.explanation).not.toMatch(/[-−]\s?\d/);
  });
});

describe('the structured direction agrees with the sentence', () => {
  const driver = (current: Lines, prior: Lines, metric: string) =>
    identifyKeyDrivers(current, prior).find((d) => d.metric === metric)!;

  it('is up or down from a nil prior, not flat', () => {
    expect(driver({ ...CURRENT, revenue: 1_000_000 }, { ...PRIOR, revenue: 0 }, 'revenue').direction).toBe('up');
    expect(driver({ ...CURRENT, netProfit: -5_000 }, { ...PRIOR, netProfit: 0 }, 'netProfit').direction).toBe('down');
  });

  it('is flat where nothing moved from nil', () => {
    const d = driver({ ...CURRENT, revenue: 0 }, { ...PRIOR, revenue: 0 }, 'revenue');
    expect(d.direction).toBe('flat');
    expect(d.explanation).toBe('Revenue remained flat');
  });
});
