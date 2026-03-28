/**
 * TDD: AI Financial Report Narrative Tests
 * RED phase.
 */

import { describe, it, expect } from 'vitest';
import {
  buildNarrativePrompt,
  parseNarrativeResponse,
  buildVarianceCommentary,
  buildTrendAnalysis,
  formatNarrativeContext,
  type ReportData,
  type NarrativeResult,
  type VarianceItem,
  type TrendPoint,
  type NarrativeTone,
} from '@/modules/accounting/services/reportNarrativeService';

// ═══════════════════════════════════════════════════════════════════════════
// NARRATIVE PROMPT
// ═══════════════════════════════════════════════════════════════════════════

describe('Narrative Prompt Building', () => {
  const sampleData: ReportData = {
    reportType: 'income_statement',
    period: '2026-03',
    companyName: 'IsaFlow Pty Ltd',
    currentPeriod: { revenue: 500000, expenses: 350000, netProfit: 150000 },
    priorPeriod: { revenue: 450000, expenses: 320000, netProfit: 130000 },
    budget: { revenue: 480000, expenses: 340000, netProfit: 140000 },
  };

  it('includes report type', () => {
    const prompt = buildNarrativePrompt(sampleData, 'professional');
    expect(prompt.toLowerCase()).toContain('income statement');
  });

  it('includes current period figures', () => {
    const prompt = buildNarrativePrompt(sampleData, 'professional');
    expect(prompt).toContain('500');
    expect(prompt).toContain('150');
  });

  it('includes prior period for comparison', () => {
    const prompt = buildNarrativePrompt(sampleData, 'professional');
    expect(prompt).toContain('450');
  });

  it('includes budget figures', () => {
    const prompt = buildNarrativePrompt(sampleData, 'professional');
    expect(prompt).toContain('480');
  });

  it('specifies tone', () => {
    const professional = buildNarrativePrompt(sampleData, 'professional');
    const simplified = buildNarrativePrompt(sampleData, 'simplified');
    expect(professional).toContain('professional');
    expect(simplified).toContain('simplified');
  });

  it('requests structured output', () => {
    const prompt = buildNarrativePrompt(sampleData, 'professional');
    expect(prompt.toLowerCase()).toContain('json');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// NARRATIVE RESPONSE PARSING
// ═══════════════════════════════════════════════════════════════════════════

describe('Narrative Response Parsing', () => {
  it('parses JSON narrative response', () => {
    const response = '{"summary":"Revenue grew 11%","highlights":["Revenue up R50k","Profit margin improved"],"concerns":["Expenses rose 9%"],"recommendations":["Monitor cost growth"]}';
    const result = parseNarrativeResponse(response);
    expect(result).toBeDefined();
    expect(result!.summary).toContain('Revenue');
    expect(result!.highlights.length).toBeGreaterThan(0);
  });

  it('handles markdown-wrapped JSON', () => {
    const response = '```json\n{"summary":"Good month","highlights":["Revenue up"],"concerns":[],"recommendations":[]}\n```';
    const result = parseNarrativeResponse(response);
    expect(result).toBeDefined();
    expect(result!.summary).toContain('Good');
  });

  it('returns null for invalid response', () => {
    expect(parseNarrativeResponse('')).toBeNull();
    expect(parseNarrativeResponse('just text')).toBeNull();
  });

  it('handles plain text fallback', () => {
    const response = 'Revenue increased by 11% compared to the prior period. Expenses grew at a slower rate.';
    const result = parseNarrativeResponse(response);
    // Should create a basic structure from plain text
    expect(result).toBeDefined();
    expect(result!.summary.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// VARIANCE COMMENTARY
// ═══════════════════════════════════════════════════════════════════════════

describe('Variance Commentary', () => {
  it('generates commentary for favorable revenue variance', () => {
    const items: VarianceItem[] = [
      { account: 'Sales Revenue', actual: 500000, budget: 450000, isExpense: false },
    ];
    const commentary = buildVarianceCommentary(items);
    expect(commentary.length).toBeGreaterThan(0);
    expect(commentary[0]!.direction).toBe('favorable');
    expect(commentary[0]!.percentVariance).toBeCloseTo(11.11, 0);
  });

  it('generates commentary for unfavorable expense variance', () => {
    const items: VarianceItem[] = [
      { account: 'Rent', actual: 120000, budget: 100000, isExpense: true },
    ];
    const commentary = buildVarianceCommentary(items);
    expect(commentary[0]!.direction).toBe('unfavorable');
  });

  it('generates favorable for under-budget expenses', () => {
    const items: VarianceItem[] = [
      { account: 'Travel', actual: 8000, budget: 15000, isExpense: true },
    ];
    const commentary = buildVarianceCommentary(items);
    expect(commentary[0]!.direction).toBe('favorable');
  });

  it('sorts by absolute variance descending', () => {
    const items: VarianceItem[] = [
      { account: 'Small item', actual: 1100, budget: 1000, isExpense: false },
      { account: 'Big item', actual: 200000, budget: 100000, isExpense: false },
    ];
    const commentary = buildVarianceCommentary(items);
    expect(commentary[0]!.account).toBe('Big item');
  });

  it('handles empty items', () => {
    expect(buildVarianceCommentary([]).length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TREND ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

describe('Trend Analysis', () => {
  it('detects upward trend', () => {
    const points: TrendPoint[] = [
      { period: '2026-01', value: 100000 },
      { period: '2026-02', value: 110000 },
      { period: '2026-03', value: 125000 },
    ];
    const result = buildTrendAnalysis(points, 'Revenue');
    expect(result.direction).toBe('up');
    expect(result.changePercent).toBeGreaterThan(0);
  });

  it('detects downward trend', () => {
    const points: TrendPoint[] = [
      { period: '2026-01', value: 100000 },
      { period: '2026-02', value: 90000 },
      { period: '2026-03', value: 75000 },
    ];
    const result = buildTrendAnalysis(points, 'Revenue');
    expect(result.direction).toBe('down');
  });

  it('detects flat trend', () => {
    const points: TrendPoint[] = [
      { period: '2026-01', value: 100000 },
      { period: '2026-02', value: 100500 },
      { period: '2026-03', value: 99800 },
    ];
    const result = buildTrendAnalysis(points, 'Revenue');
    expect(result.direction).toBe('flat');
  });

  it('calculates period-over-period change', () => {
    const points: TrendPoint[] = [
      { period: '2026-01', value: 100000 },
      { period: '2026-02', value: 120000 },
    ];
    const result = buildTrendAnalysis(points, 'Metric');
    expect(result.changePercent).toBeCloseTo(20, 0);
  });

  it('handles single data point', () => {
    const result = buildTrendAnalysis([{ period: '2026-01', value: 100000 }], 'Test');
    expect(result.direction).toBe('flat');
    expect(result.changePercent).toBe(0);
  });

  it('generates narrative description', () => {
    const points: TrendPoint[] = [
      { period: '2026-01', value: 100000 },
      { period: '2026-03', value: 150000 },
    ];
    const result = buildTrendAnalysis(points, 'Revenue');
    expect(result.narrative.length).toBeGreaterThan(0);
    expect(result.narrative).toContain('Revenue');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONTEXT FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

describe('Narrative Context Formatting', () => {
  it('formats financial data for prompt', () => {
    const ctx = formatNarrativeContext({
      revenue: 500000, expenses: 350000, netProfit: 150000,
    });
    expect(ctx).toContain('Revenue');
    expect(ctx).toContain('500');
    expect(ctx).toContain('Profit');
  });

  it('includes ZAR formatting', () => {
    const ctx = formatNarrativeContext({ revenue: 1500000, expenses: 0, netProfit: 0 });
    expect(ctx).toContain('R');
  });
});
