/**
 * The draft builder places sentences: which pack section they sit under and
 * which figure they explain. What matters here is not the prose — that comes
 * from the analysers in aiCommentaryService, which have their own tests — but
 * the placement, the absence of prior-period claims when there is no prior
 * period, and the uniqueness of section+row, which is the table's uniqueness
 * key and therefore the ON CONFLICT target in commentaryService.
 *
 * Mutation check: drop the `if (data.priorPeriod)` guard and the third test
 * goes red; return `d.metric` for every driver without slicing and the
 * uniqueness test still holds, but change rowRef to a constant and it fails.
 */
import { describe, it, expect } from 'vitest';
import { buildDraftSentences } from '@/modules/accounting/services/commentary/commentaryDraft';
import type { CommentaryPackData } from '@/modules/accounting/services/commentary/commentaryDraft';
import type { ManagementPackData } from '@/modules/accounting/services/reports/aiCommentaryService';

const data: ManagementPackData = {
  companyName: 'Britech',
  period: '2026-03-01 to 2026-08-31',
  incomeStatement: { revenue: 1_000_000, costOfSales: 600_000, grossProfit: 400_000, operatingExpenses: 250_000, netProfit: 150_000 },
  balanceSheet: { totalAssets: 2_000_000, totalLiabilities: 800_000, equity: 1_200_000, currentRatio: 0.9, debtEquityRatio: 0.67 },
  priorPeriod: { revenue: 800_000, costOfSales: 500_000, grossProfit: 300_000, operatingExpenses: 220_000, netProfit: 80_000 },
  ratios: { grossMargin: 40, netMargin: 15, currentRatio: 0.9, quickRatio: 0.7 },
};

describe('buildDraftSentences', () => {
  it('files the biggest driver under the income statement section', () => {
    const s = buildDraftSentences(data);
    const is = s.filter(x => x.sectionRef === 'income_statement');
    expect(is.length).toBeGreaterThan(0);
    expect(is[0]!.text).toContain('Revenue');
    expect(is[0]!.rowRef).toBe('revenue');
  });

  it('files a liquidity risk under the balance sheet section', () => {
    const s = buildDraftSentences(data);
    const bs = s.filter(x => x.sectionRef === 'balance_sheet');
    expect(bs.some(x => x.text.includes('Current ratio') || x.text.includes('current ratio'))).toBe(true);
  });

  it('produces no prior-period sentences when there is no prior period', () => {
    const s = buildDraftSentences({ ...data, priorPeriod: undefined });
    expect(s.filter(x => x.sectionRef === 'income_statement')).toEqual([]);
  });

  it('never returns an empty sentence, and every sentence has a unique section+row key', () => {
    const s = buildDraftSentences(data);
    expect(s.every(x => x.text.trim().length > 0)).toBe(true);
    const keys = s.map(x => `${x.sectionRef}:${x.rowRef}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('leverage disclosure', () => {
  it('says so explicitly when equity is negative, instead of falling silent', () => {
    const insolvent: CommentaryPackData = {
      ...data,
      balanceSheet: {
        totalAssets: 500_000, totalLiabilities: 900_000, equity: -400_000,
        currentRatio: 0.4,
        // The ratio does not exist: dividing by negative equity inverts the ranking.
        debtEquityRatio: null,
        debtEquityUnavailableReason:
          'Equity is negative — liabilities exceed assets, so this ratio inverts and cannot be ranked.',
      },
    };
    const s = buildDraftSentences(insolvent);
    const equityRow = s.find(x => x.sectionRef === 'balance_sheet' && x.rowRef === 'equity');

    expect(equityRow).toBeDefined();
    expect(equityRow!.text).toContain('Equity is negative');
    // The 0 handed to assessRiskAreas silences its branch; it must never surface
    // as a printed figure.
    expect(s.every(x => !x.text.includes('Debt-to-equity 0.00'))).toBe(true);
  });

  it('falls back to the reporting engine wording when no reason travelled with the null', () => {
    const zeroEquity: CommentaryPackData = {
      ...data,
      balanceSheet: { ...data.balanceSheet, equity: 0, debtEquityRatio: null },
    };
    const equityRow = buildDraftSentences(zeroEquity)
      .find(x => x.sectionRef === 'balance_sheet' && x.rowRef === 'equity');

    expect(equityRow!.text).toContain('no equity to divide by');
  });

  it('emits no equity sentence when the ratio exists', () => {
    const s = buildDraftSentences(data);
    expect(s.some(x => x.rowRef === 'equity')).toBe(false);
  });

  it('reports the worst gearing as a crisis, not merely a risk', () => {
    const geared: CommentaryPackData = {
      ...data,
      balanceSheet: { ...data.balanceSheet, debtEquityRatio: 4.2 },
    };
    const texts = buildDraftSentences(geared).map(x => x.text);
    expect(texts.some(t => t.includes('exceeds 3.0'))).toBe(true);
    expect(texts.some(t => t.includes('exceeds 2.0'))).toBe(false);

    const moderate: CommentaryPackData = {
      ...data,
      balanceSheet: { ...data.balanceSheet, debtEquityRatio: 2.5 },
    };
    expect(buildDraftSentences(moderate).map(x => x.text).some(t => t.includes('exceeds 2.0'))).toBe(true);
  });
});
