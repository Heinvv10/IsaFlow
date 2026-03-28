/**
 * AI-Enhanced Cash Flow Forecasting Service
 * Payment probability, seasonal patterns, scenarios, 13-week rolling forecast.
 * Pure business logic — no database dependencies.
 */

export interface PaymentHistory {
  totalInvoices: number;
  paidOnTime: number;
  paidLate: number;
  unpaid: number;
  avgDaysToPayment: number;
}

export interface PaymentScore {
  probability: number;
  rating: 'reliable' | 'moderate' | 'poor' | 'unknown';
  estimatedDays: number;
}

export interface SeasonalPattern {
  hasSeasonality: boolean;
  peakMonth: number;
  troughMonth: number;
  factors: number[];
}

export interface ForecastScenario {
  name: 'optimistic' | 'base' | 'pessimistic';
  points: Array<{ month: number; inflow: number; outflow: number; closingBalance: number }>;
  alerts: string[];
}

export interface WeeklyForecast {
  weeks: Array<{ week: number; inflow: number; outflow: number; closingBalance: number }>;
  alertWeeks: number[];
  lowestBalance: number;
  lowestWeek: number;
}

export interface ForecastNarrative {
  summary: string;
  risks: string[];
  actions: string[];
}

// ═══════════════════════════════════════════════════════════════════════════
// PAYMENT PROBABILITY
// ═══════════════════════════════════════════════════════════════════════════

export function scorePaymentProbability(history: PaymentHistory): PaymentScore {
  if (history.totalInvoices === 0) {
    return { probability: 0.5, rating: 'unknown', estimatedDays: 30 };
  }

  const onTimeRate = history.paidOnTime / history.totalInvoices;
  const unpaidRate = history.unpaid / history.totalInvoices;
  const lateRate = history.paidLate / history.totalInvoices;

  // Weighted score: on-time is good, unpaid is very bad, late is moderately bad
  let probability = onTimeRate * 0.7 + (1 - unpaidRate) * 0.2 + (1 - lateRate) * 0.1;
  probability = Math.round(Math.max(0, Math.min(1, probability)) * 100) / 100;

  let rating: PaymentScore['rating'] = 'moderate';
  if (probability >= 0.85) rating = 'reliable';
  else if (probability < 0.5) rating = 'poor';

  const estimatedDays = Math.max(1, Math.round(history.avgDaysToPayment || 30));

  return { probability, rating, estimatedDays };
}

// ═══════════════════════════════════════════════════════════════════════════
// SEASONAL PATTERN DETECTION
// ═══════════════════════════════════════════════════════════════════════════

export function detectSeasonalPattern(monthlyData: number[]): SeasonalPattern {
  if (monthlyData.length < 6) {
    return { hasSeasonality: false, peakMonth: 0, troughMonth: 0, factors: [] };
  }

  const avg = monthlyData.reduce((s, v) => s + v, 0) / monthlyData.length;
  if (avg === 0) return { hasSeasonality: false, peakMonth: 0, troughMonth: 0, factors: [] };

  const factors = monthlyData.map(v => Math.round((v / avg) * 100) / 100);

  // Detect seasonality: coefficient of variation > 15%
  const variance = monthlyData.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / monthlyData.length;
  const stdDev = Math.sqrt(variance);
  const cv = stdDev / avg;

  const peakIdx = monthlyData.indexOf(Math.max(...monthlyData));
  const troughIdx = monthlyData.indexOf(Math.min(...monthlyData));

  return {
    hasSeasonality: cv > 0.15,
    peakMonth: peakIdx + 1,
    troughMonth: troughIdx + 1,
    factors: monthlyData.length >= 12 ? factors : [],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO MODELING
// ═══════════════════════════════════════════════════════════════════════════

const SCENARIO_MULTIPLIERS = {
  optimistic: { inflow: 1.15, outflow: 0.95 },
  base: { inflow: 1.0, outflow: 1.0 },
  pessimistic: { inflow: 0.8, outflow: 1.1 },
};

export function buildForecastScenario(
  scenario: 'optimistic' | 'base' | 'pessimistic',
  input: { baseRevenue: number; baseExpenses: number; cashBalance: number; months: number },
): ForecastScenario {
  const mult = SCENARIO_MULTIPLIERS[scenario];
  const points: ForecastScenario['points'] = [];
  const alerts: string[] = [];
  let balance = input.cashBalance;

  for (let m = 0; m < input.months; m++) {
    const inflow = Math.round(input.baseRevenue * mult.inflow * 100) / 100;
    const outflow = Math.round(input.baseExpenses * mult.outflow * 100) / 100;
    balance = Math.round((balance + inflow - outflow) * 100) / 100;

    points.push({ month: m + 1, inflow, outflow, closingBalance: balance });

    if (balance < 0) {
      alerts.push(`Cash shortfall of R${Math.abs(balance).toLocaleString()} projected in month ${m + 1} (${scenario} scenario)`);
    }
  }

  return { name: scenario, points, alerts };
}

// ═══════════════════════════════════════════════════════════════════════════
// 13-WEEK ROLLING FORECAST
// ═══════════════════════════════════════════════════════════════════════════

export function calculateWeeklyForecast(input: {
  openingBalance: number;
  weeklyInflow: number;
  weeklyOutflow: number;
  weeks: number;
  minimumBalance?: number;
}): WeeklyForecast {
  const weeks: WeeklyForecast['weeks'] = [];
  const alertWeeks: number[] = [];
  let balance = input.openingBalance;
  let lowestBalance = input.openingBalance;
  let lowestWeek = 0;
  const minBal = input.minimumBalance ?? 0;

  for (let w = 0; w < input.weeks; w++) {
    balance = Math.round((balance + input.weeklyInflow - input.weeklyOutflow) * 100) / 100;
    weeks.push({ week: w + 1, inflow: input.weeklyInflow, outflow: input.weeklyOutflow, closingBalance: balance });

    if (balance < lowestBalance) { lowestBalance = balance; lowestWeek = w + 1; }
    if (balance < minBal) alertWeeks.push(w + 1);
  }

  return { weeks, alertWeeks, lowestBalance, lowestWeek };
}

// ═══════════════════════════════════════════════════════════════════════════
// FORECAST NARRATIVE
// ═══════════════════════════════════════════════════════════════════════════

export function buildForecastNarrativePrompt(data: {
  currentBalance: number;
  projectedBalance: number;
  months: number;
  lowestPoint: number;
  lowestMonth: string;
}): string {
  return `You are a South African CFO advisor. Analyze this cash flow forecast:

Current Balance: R${data.currentBalance.toLocaleString()}
Projected Balance (${data.months} months): R${data.projectedBalance.toLocaleString()}
Lowest Point: R${data.lowestPoint.toLocaleString()} in ${data.lowestMonth}

Respond in JSON:
{"summary": "2-3 sentence analysis", "risks": ["risk 1", "..."], "actions": ["action 1", "..."]}`;
}

export function parseForecastNarrative(response: string): ForecastNarrative | null {
  if (!response || response.trim() === '') return null;

  try {
    let jsonStr = response;
    const match = response.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/) || response.match(/\{[\s\S]*"summary"[\s\S]*\}/);
    if (match) jsonStr = match[1] || match[0];
    const parsed = JSON.parse(jsonStr);
    if (parsed.summary) return { summary: String(parsed.summary), risks: (parsed.risks || []).map(String), actions: (parsed.actions || []).map(String) };
  } catch { /* not JSON */ }

  // Plain text fallback
  const sentences = response.split(/[.!?]+/).filter(s => s.trim().length > 10);
  if (sentences.length > 0) return { summary: sentences.slice(0, 2).join('. ').trim() + '.', risks: [], actions: [] };

  return null;
}
