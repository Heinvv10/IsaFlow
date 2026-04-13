/**
 * AI Financial Report Narrative Service
 * Generates management commentary, variance analysis, trend narratives.
 * Pure business logic — no database dependencies.
 */

export type NarrativeTone = 'professional' | 'simplified' | 'executive';

export interface ReportData {
  reportType: 'income_statement' | 'balance_sheet' | 'cash_flow' | 'budget_vs_actual';
  period: string;
  companyName: string;
  currentPeriod: { revenue: number; expenses: number; netProfit: number };
  priorPeriod?: { revenue: number; expenses: number; netProfit: number };
  budget?: { revenue: number; expenses: number; netProfit: number };
}

export interface NarrativeResult {
  summary: string;
  highlights: string[];
  concerns: string[];
  recommendations: string[];
}

export interface VarianceItem {
  account: string;
  actual: number;
  budget: number;
  isExpense: boolean;
}

export interface VarianceCommentary {
  account: string;
  varianceAmount: number;
  percentVariance: number;
  direction: 'favorable' | 'unfavorable' | 'on_budget';
  commentary: string;
}

export interface TrendPoint {
  period: string;
  value: number;
}

export interface TrendResult {
  direction: 'up' | 'down' | 'flat';
  changePercent: number;
  narrative: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONTEXT FORMATTING
// ═══════════════════════════════════════════════════════════════════════════

const fmt = (n: number) => `R${Math.abs(n).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export function formatNarrativeContext(data: { revenue: number; expenses: number; netProfit: number }): string {
  return `Revenue: ${fmt(data.revenue)} | Expenses: ${fmt(data.expenses)} | Net Profit: ${fmt(data.netProfit)} | Profit Margin: ${data.revenue > 0 ? Math.round((data.netProfit / data.revenue) * 100) : 0}%`;
}

// ═══════════════════════════════════════════════════════════════════════════
// NARRATIVE PROMPT
// ═══════════════════════════════════════════════════════════════════════════

const REPORT_TYPE_LABELS: Record<string, string> = {
  income_statement: 'Income Statement (Profit & Loss)',
  balance_sheet: 'Balance Sheet',
  cash_flow: 'Cash Flow Statement',
  budget_vs_actual: 'Budget vs Actual Report',
};

export function buildNarrativePrompt(data: ReportData, tone: NarrativeTone): string {
  const reportLabel = REPORT_TYPE_LABELS[data.reportType] || data.reportType;

  let context = `Report: ${reportLabel}\nPeriod: ${data.period}\nCompany: ${data.companyName}\n\n`;
  context += `Current Period:\n  ${formatNarrativeContext(data.currentPeriod)}\n`;

  if (data.priorPeriod) {
    context += `\nPrior Period:\n  ${formatNarrativeContext(data.priorPeriod)}\n`;
    const revChange = data.priorPeriod.revenue > 0 ? Math.round(((data.currentPeriod.revenue - data.priorPeriod.revenue) / data.priorPeriod.revenue) * 100) : 0;
    context += `  Revenue Change: ${revChange}%\n`;
  }

  if (data.budget) {
    context += `\nBudget:\n  ${formatNarrativeContext(data.budget)}\n`;
    const revVar = data.budget.revenue > 0 ? Math.round(((data.currentPeriod.revenue - data.budget.revenue) / data.budget.revenue) * 100) : 0;
    context += `  Revenue vs Budget: ${revVar}%\n`;
  }

  return `You are a South African chartered accountant writing a ${tone} management report narrative.

${context}

Write a commentary for this ${reportLabel}. Tone: ${tone}.

Respond in JSON:
{"summary": "2-3 sentence overview", "highlights": ["positive point 1", "..."], "concerns": ["concern 1", "..."], "recommendations": ["action item 1", "..."]}

Rules:
- Use ZAR (South African Rand) for all amounts
- Be specific with numbers and percentages
- ${tone === 'simplified' ? 'Use simple language suitable for non-financial directors' : 'Use professional accounting terminology'}
- Focus on actionable insights`;
}

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE PARSING
// ═══════════════════════════════════════════════════════════════════════════

export function parseNarrativeResponse(response: string): NarrativeResult | null {
  if (!response || response.trim() === '') return null;

  // Try JSON
  try {
    let jsonStr = response;
    const jsonMatch = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonMatch) jsonStr = jsonMatch[1]!;
    else {
      const objMatch = response.match(/\{[\s\S]*"summary"[\s\S]*\}/);
      if (objMatch) jsonStr = objMatch[0];
    }

    const parsed = JSON.parse(jsonStr);
    if (parsed.summary) {
      return {
        summary: String(parsed.summary),
        highlights: Array.isArray(parsed.highlights) ? parsed.highlights.map(String) : [],
        concerns: Array.isArray(parsed.concerns) ? parsed.concerns.map(String) : [],
        recommendations: Array.isArray(parsed.recommendations) ? parsed.recommendations.map(String) : [],
      };
    }
  } catch { /* not JSON */ }

  // Plain text fallback — use first sentence as summary
  const sentences = response.split(/[.!?]+/).filter(s => s.trim().length > 10);
  if (sentences.length > 0) {
    return {
      summary: sentences.slice(0, 2).join('. ').trim() + '.',
      highlights: [],
      concerns: [],
      recommendations: [],
    };
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// VARIANCE COMMENTARY
// ═══════════════════════════════════════════════════════════════════════════

export function buildVarianceCommentary(items: VarianceItem[]): VarianceCommentary[] {
  if (items.length === 0) return [];

  return items
    .map(item => {
      const varianceAmount = item.actual - item.budget;
      const percentVariance = item.budget !== 0 ? Math.round((varianceAmount / item.budget) * 10000) / 100 : 0;

      let direction: VarianceCommentary['direction'] = 'on_budget';
      if (varianceAmount > 0) direction = item.isExpense ? 'unfavorable' : 'favorable';
      else if (varianceAmount < 0) direction = item.isExpense ? 'favorable' : 'unfavorable';

      const dirLabel = direction === 'favorable' ? 'favorably' : direction === 'unfavorable' ? 'unfavorably' : 'on budget';
      const commentary = `${item.account} came in ${dirLabel} at ${fmt(item.actual)} vs budget of ${fmt(item.budget)} (${percentVariance > 0 ? '+' : ''}${percentVariance}%).`;

      return { account: item.account, varianceAmount, percentVariance, direction, commentary };
    })
    .sort((a, b) => Math.abs(b.varianceAmount) - Math.abs(a.varianceAmount));
}

// ═══════════════════════════════════════════════════════════════════════════
// TREND ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════

export function buildTrendAnalysis(points: TrendPoint[], metricName: string): TrendResult {
  if (points.length <= 1) {
    return { direction: 'flat', changePercent: 0, narrative: `${metricName} has insufficient data for trend analysis.` };
  }

  const first = points[0]!.value;
  const last = points[points.length - 1]!.value;
  const changePercent = first !== 0 ? Math.round(((last - first) / first) * 10000) / 100 : 0;

  const FLAT_THRESHOLD = 2; // ±2% = flat
  let direction: TrendResult['direction'] = 'flat';
  if (changePercent > FLAT_THRESHOLD) direction = 'up';
  else if (changePercent < -FLAT_THRESHOLD) direction = 'down';

  const dirLabel = direction === 'up' ? 'increased' : direction === 'down' ? 'decreased' : 'remained stable';
  const narrative = `${metricName} ${dirLabel} by ${Math.abs(changePercent)}% from ${fmt(first)} to ${fmt(last)} over ${points.length} periods.`;

  return { direction, changePercent, narrative };
}
