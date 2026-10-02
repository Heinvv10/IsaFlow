/**
 * THE DASHBOARD'S EXECUTIVE SUMMARY WRITES ITS FIGURES AS THE PACK DOES.
 *
 * Its highlights and alerts built prose with `toFixed` and `toLocaleString`:
 * "Low gross margin of -1310.8%", "Liquidity risk — current ratio below 1.0
 * at -0.14", "Net loss of R 1544240.9" — hyphens for minus signs, no
 * grouping, no cents — and it took margins on revenue that was zero or
 * negative, where the ratio engine says there is no margin. A company with
 * no current liabilities got "Current ratio 0.00 — current liabilities
 * exceed current assets".
 *
 * Margins and ratios now come from the engine; a margin in a sentence
 * carries its sign in a word (`pctWithWord`, as the pack's prose); money is
 * `formatMoney` in the pack's notation; a ratio is in its unit.
 */
import { describe, expect, it } from 'vitest';
import {
  generateAlerts, generateHighlights, type ExecutiveSummaryInput,
} from '@/modules/accounting/services/reports/executiveSummaryService';

const plain = (s: string): string => s.replace(/[  ]/g, ' ');
const messages = (xs: Array<{ message: string }>): string[] => xs.map((x) => plain(x.message));

/** The demo company: a sliver of revenue under a large cost base. */
const LOSS: ExecutiveSummaryInput = {
  period: '2026-01-01 to 2026-09-07', companyName: 'ISAFlow Demo (Pty) Ltd',
  revenue: 101_400, costOfSales: 1_430_581.6, operatingExpenses: 215_059.3, netProfit: -1_544_240.9,
  totalAssets: 900_000, totalLiabilities: 1_300_000, totalEquity: -400_000,
  currentAssets: -140_000, currentLiabilities: 1_000_000, cash: 20_000,
  accountsReceivable: 58_000, accountsPayable: 300_000, inventory: 0,
  priorRevenue: 150_000, priorNetProfit: 80_000,
};
/** Brightsphere: credit notes exceeding sales. */
const NEGATIVE_REVENUE: ExecutiveSummaryInput = { ...LOSS, revenue: -5_535_000, costOfSales: 0, netProfit: -6_400_000 };
const HEALTHY: ExecutiveSummaryInput = {
  ...LOSS, revenue: 4_200_000.55, costOfSales: 2_100_000, netProfit: 700_000, totalEquity: 1_000_000,
  totalLiabilities: 2_500_000, currentAssets: 2_400_000, currentLiabilities: 1_000_000, cash: 500_000,
  priorRevenue: 3_000_000, priorNetProfit: 500_000,
};

const NO_HYPHEN_FIGURE = /[-−]\s?\d/;

describe('on a loss on positive revenue', () => {
  const highlights = messages(generateHighlights(LOSS));
  const alerts = messages(generateAlerts(LOSS));

  it('states the margins with their sign in a word, to one decimal, grouped', () => {
    expect(highlights).toContain('Gross margin is a negative 1 310.8% — review cost structure');
  });

  it('states revenue growth as a decline, in a word', () => {
    expect(highlights).toContain('Revenue declined 32.4% vs prior period');
  });

  it('states the current ratio in the pack\'s notation', () => {
    expect(highlights).toContain('Current ratio is (0.14)×, below 1.00× — liquidity risk');
    expect(alerts).toContain('Current ratio (0.14)× — current liabilities exceed current assets');
  });

  it('states the loss as money: grouped, with cents', () => {
    expect(alerts).toContain('Net loss of R 1 544 240.90 reported this period');
  });

  it('states the fall in net profit in a word', () => {
    expect(alerts).toContain('Net profit declined 2 030.3% vs prior period');
  });

  it('carries no minus sign in any sentence', () => {
    for (const m of [...highlights, ...alerts]) expect(m).not.toMatch(NO_HYPHEN_FIGURE);
  });
});

describe('on negative revenue', () => {
  const highlights = messages(generateHighlights(NEGATIVE_REVENUE));

  it('states no margin, and says why in the engine\'s words', () => {
    expect(highlights).toContain('Margins are not stated: revenue is not positive, so no margin has a meaning.');
    expect(highlights.join('\n')).not.toMatch(/margin (of|is) /);
  });

  it('carries no minus sign', () => {
    for (const m of highlights) expect(m).not.toMatch(NO_HYPHEN_FIGURE);
  });
});

describe('where a ratio has no base', () => {
  it('says nothing about a current ratio a company with no current liabilities does not have', () => {
    const input = { ...HEALTHY, currentLiabilities: 0 };
    const all = [...messages(generateHighlights(input)), ...messages(generateAlerts(input))];
    expect(all.join('\n')).not.toMatch(/current ratio/i);
  });
});

describe('on healthy figures', () => {
  it('writes each figure in its unit', () => {
    expect(messages(generateHighlights(HEALTHY))).toEqual([
      'Revenue grew 40.0% vs prior period',
      'Gross margin is a positive 50.0% — strong',
      'Net profit margin is a positive 16.7% — healthy',
      'Current ratio is 2.40× — strong liquidity',
    ]);
  });

  it('states high leverage as a ratio in its unit', () => {
    expect(messages(generateAlerts(HEALTHY))).toEqual(['High leverage — debt-to-equity ratio at 2.50×']);
  });
});

describe('a margin that rounds to nil', () => {
  it('reads "nil", not "a positive 0.0%" or "a negative 0.0%"', () => {
    const text = messages(generateHighlights({ ...HEALTHY, costOfSales: HEALTHY.revenue + 1, netProfit: -1 }));
    expect(text).toContain('Gross margin is nil — review cost structure');
    expect(text).toContain('Net profit margin is nil — thin, monitor closely');
    expect(text.join('\n')).not.toMatch(/(positive|negative) 0\.0%/);
  });
});

describe('a revenue movement that rounds to nil', () => {
  it('is not reported as growth of 0.0%', () => {
    // +0.04%: this read "Revenue grew 0.0%".
    const text = messages(generateHighlights({ ...HEALTHY, priorRevenue: 4_198_321 }));
    expect(text.join('\n')).not.toMatch(/Revenue (grew|declined)/);
  });
});
