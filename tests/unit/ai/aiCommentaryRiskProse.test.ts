/**
 * THE AI COMMENTARY'S RISK SENTENCES WRITE THEIR FIGURES AS THE PACK DOES.
 *
 * `assessRiskAreas` built its sentences with `toFixed`: "Gross margin
 * -1310.8% is below 20%", "Current ratio -0.14 is below 1.0" — a hyphen for a
 * minus in a product whose every other surface brackets a negative or puts
 * its sign in a word, and no grouping. A margin in a sentence now carries its
 * sign in a word (`pctWithWord`), a ratio is in its unit (`formatRatioOf`),
 * and a margin the caller could not state (null) raises no margin sentence.
 */
import { describe, expect, it } from 'vitest';
import { assessRiskAreas, type ManagementPackData } from '@/modules/accounting/services/reports/aiCommentaryService';

const plain = (s: string): string => s.replace(/[  ]/g, ' ');

const DATA: ManagementPackData = {
  companyName: 'Demo', period: '2026-01',
  incomeStatement: { revenue: 101_400, costOfSales: 1_430_581.6, grossProfit: -1_329_181.6, operatingExpenses: 215_059.3, netProfit: -1_544_240.9 },
  balanceSheet: { totalAssets: 900_000, totalLiabilities: 3_100_000, equity: 1_000_000, currentRatio: -0.14, debtEquityRatio: 3.1 },
  ratios: { grossMargin: -1310.83, netMargin: -1522.92, currentRatio: -0.14, quickRatio: -0.14 },
};

const sentences = (data: ManagementPackData): string[] => assessRiskAreas(data).map((r) => plain(r.description));

describe('the risk sentences on a loss', () => {
  const text = sentences(DATA);

  it('state a negative margin with its sign in a word, grouped, to one decimal', () => {
    expect(text).toContain('Gross margin is a negative 1 310.8%, below 20.0%');
    expect(text).toContain('Net margin is a negative 1 522.9%, below 5.0%');
  });

  it('state the ratios in the pack\'s notation', () => {
    expect(text).toContain('Current ratio (0.14) is below 1.00 — unable to cover short-term obligations');
    expect(text).toContain('Debt-to-equity 3.10 exceeds 3.00');
  });

  it('carry no minus sign', () => {
    for (const s of text) expect(s).not.toMatch(/[-−]\s?\d/);
  });
});

describe('where a margin could not be stated', () => {
  it('raises no margin sentence at all', () => {
    const text = sentences({ ...DATA, ratios: { ...DATA.ratios, grossMargin: null, netMargin: null } });
    expect(text.join('\n')).not.toMatch(/margin/i);
  });
});

describe('on ordinary figures', () => {
  it('state a thin positive margin as such', () => {
    const text = sentences({
      ...DATA,
      balanceSheet: { ...DATA.balanceSheet, currentRatio: 1.2, debtEquityRatio: 2.5 },
      ratios: { grossMargin: 18.25, netMargin: 3, currentRatio: 1.2, quickRatio: 1 },
    });
    expect(text).toEqual([
      'Current ratio 1.20 is below recommended 1.50',
      'Debt-to-equity 2.50 exceeds 2.00 — high financial leverage',
      'Gross margin is a positive 18.3%, below 20.0%',
      'Net margin is a positive 3.0%, below 5.0%',
    ]);
  });
});

describe('a margin that rounds to nil', () => {
  it('reads "nil", unsigned', () => {
    const text = sentences({ ...DATA, ratios: { ...DATA.ratios, grossMargin: -0.01, netMargin: 0 } });
    expect(text).toContain('Gross margin is nil, below 20.0%');
    expect(text).toContain('Net margin is nil, below 5.0%');
  });
});
