/**
 * Cash Flow Forecast — AI Service
 * Builds the AI prompt, calls Anthropic API, parses the response, and caches results.
 */

import { log } from '@/lib/logger';
import {
  getActualCashFlow,
  getBankBalance,
  getUpcomingReceivablesAndPayables,
  getRecurringTemplates,
  toNum,
  type CashFlowPeriod,
  type UpcomingItem,
  type RecurringTemplate,
} from './cashFlowForecastDataService';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ForecastWeek {
  weekStart: string;
  projectedInflows: number;
  projectedOutflows: number;
  projectedNet: number;
  confidence: 'high' | 'medium' | 'low';
  notes: string;
}

export interface CashFlowForecast {
  companyId: string;
  generatedAt: string;
  horizonDays: number;
  historicalPeriods: CashFlowPeriod[];
  forecastPeriods: ForecastWeek[];
  summary: string;
  risks: string[];
  opportunities: string[];
  currentCashBalance: number;
  projectedEndBalance: number;
}

// ── System prompt ─────────────────────────────────────────────────────────────

const FORECAST_SYSTEM_PROMPT = `You are an expert South African CFO and cash flow analyst for SME businesses.
You will receive historical weekly cash flow data, upcoming invoice obligations, and recurring patterns.
Analyse the data and produce a structured JSON cash flow forecast.

Return ONLY valid JSON (no markdown, no explanation) in this exact shape:
{
  "forecast": [
    {
      "weekStart": "YYYY-MM-DD",
      "projectedInflows": 0,
      "projectedOutflows": 0,
      "projectedNet": 0,
      "confidence": "high|medium|low",
      "notes": "Brief explanation"
    }
  ],
  "summary": "One paragraph executive summary of the cash position and outlook",
  "risks": ["Risk 1", "Risk 2"],
  "opportunities": ["Opportunity 1", "Opportunity 2"]
}

Rules:
- All monetary values in ZAR (South African Rand), as plain numbers
- confidence is "high" for confirmed invoices, "medium" for patterns, "low" for projections
- risks: focus on liquidity gaps, overdue receivables, large upcoming payables
- opportunities: early payment discounts, collection improvements, idle cash investment
- Generate exactly the number of weekly buckets matching the weekStarts provided`;

// ── Cache ─────────────────────────────────────────────────────────────────────

interface ForecastCache {
  data: CashFlowForecast;
  expiresAt: number;
}

const forecastCache = new Map<string, ForecastCache>();

// ── Week builder ──────────────────────────────────────────────────────────────

function buildWeekStarts(horizonDays: number): string[] {
  const weeks: string[] = [];
  const today = new Date();
  const dow = today.getDay();
  const toMonday = dow === 1 ? 0 : dow === 0 ? 1 : 8 - dow;
  const start = new Date(today);
  start.setDate(today.getDate() + toMonday);
  const cursor = new Date(start);
  while (true) {
    const diff = Math.round((cursor.getTime() - today.getTime()) / 86400000);
    if (diff > horizonDays) break;
    weeks.push(cursor.toISOString().slice(0, 10));
    cursor.setDate(cursor.getDate() + 7);
  }
  return weeks;
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildAIPrompt(
  historical: CashFlowPeriod[],
  upcoming: UpcomingItem[],
  recurring: RecurringTemplate[],
  horizonDays: number,
  currentBalance: number,
  weekStarts: string[],
): string {
  const totalReceivable = upcoming.filter(i => i.type === 'receivable').reduce((s, i) => s + i.amount, 0);
  const totalPayable = upcoming.filter(i => i.type === 'payable').reduce((s, i) => s + i.amount, 0);

  const histLines = historical.slice(-8).map(p =>
    `  Week ${p.weekStart}: Inflows R${p.inflows.toFixed(0)}, Outflows R${p.outflows.toFixed(0)}, Net R${p.netFlow.toFixed(0)}`
  ).join('\n') || '  No historical data';

  const recvLines = upcoming.filter(i => i.type === 'receivable')
    .map(i => `  Due ${i.dueDate}: R${i.amount.toFixed(0)} (${i.status})`).join('\n') || '  None';
  const payLines = upcoming.filter(i => i.type === 'payable')
    .map(i => `  Due ${i.dueDate}: R${i.amount.toFixed(0)} (${i.status})`).join('\n') || '  None';
  const recurrLines = recurring.map(r =>
    `  ${r.name} (${r.frequency} ${r.entityType}), next: ${r.nextRunDate ?? 'unscheduled'}`
  ).join('\n') || '  None';

  return `CASH FLOW FORECAST REQUEST

Current Cash Balance: R${currentBalance.toFixed(2)}
Forecast Horizon: ${horizonDays} days
weekStarts: ${weekStarts.join(', ')}

HISTORICAL WEEKLY CASH FLOW (last ${historical.length} weeks):
${histLines}

UPCOMING RECEIVABLES (${upcoming.filter(i => i.type === 'receivable').length} invoices, total R${totalReceivable.toFixed(0)}):
${recvLines}

UPCOMING PAYABLES (${upcoming.filter(i => i.type === 'payable').length} invoices, total R${totalPayable.toFixed(0)}):
${payLines}

RECURRING PATTERNS:
${recurrLines}

Generate weekly forecast for these exact weekStarts: ${weekStarts.join(', ')}`;
}

// ── Response parser ───────────────────────────────────────────────────────────

function parseAIResponse(text: string): {
  forecast: ForecastWeek[];
  summary: string;
  risks: string[];
  opportunities: string[];
} {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  const parsed = JSON.parse(cleaned) as {
    forecast?: unknown[];
    summary?: unknown;
    risks?: unknown[];
    opportunities?: unknown[];
  };

  const forecast: ForecastWeek[] = (parsed.forecast ?? []).map((item) => {
    const w = item as Record<string, unknown>;
    const conf = String(w['confidence'] ?? 'medium');
    return {
      weekStart: String(w['weekStart'] ?? ''),
      projectedInflows: toNum(w['projectedInflows']),
      projectedOutflows: toNum(w['projectedOutflows']),
      projectedNet: toNum(w['projectedNet']),
      confidence: (['high', 'medium', 'low'].includes(conf) ? conf : 'medium') as ForecastWeek['confidence'],
      notes: String(w['notes'] ?? ''),
    };
  });

  return {
    forecast,
    summary: String(parsed.summary ?? 'No summary available.'),
    risks: (parsed.risks ?? []).map(String),
    opportunities: (parsed.opportunities ?? []).map(String),
  };
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Generate an AI-powered cash flow forecast from bank transactions + invoice data.
 * Results are cached for 4 hours per company+horizon pair.
 */
export async function getForecast(companyId: string, horizonDays: number): Promise<CashFlowForecast> {
  const cacheKey = `${companyId}:${horizonDays}`;
  const hit = forecastCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    log.info('Cash flow forecast cache hit', { companyId, horizonDays }, 'cashFlowForecast');
    return hit.data;
  }

  log.info('Generating AI cash flow forecast', { companyId, horizonDays }, 'cashFlowForecast');

  const [historical, currentBalance, upcoming, recurring] = await Promise.all([
    getActualCashFlow(companyId, 90),
    getBankBalance(companyId),
    getUpcomingReceivablesAndPayables(companyId, horizonDays),
    getRecurringTemplates(companyId),
  ]);

  const weekStarts = buildWeekStarts(horizonDays);
  const userPrompt = buildAIPrompt(historical, upcoming, recurring, horizonDays, currentBalance, weekStarts);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not configured');

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: [{ type: 'text', text: FORECAST_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!anthropicRes.ok) {
    const errText = await anthropicRes.text();
    throw new Error(`Anthropic API error ${anthropicRes.status}: ${errText}`);
  }

  const anthropicData = await anthropicRes.json() as {
    content?: Array<{ type: string; text?: string }>;
  };
  const responseText = (anthropicData.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');

  const parsed = parseAIResponse(responseText);
  const projectedEndBalance = currentBalance + parsed.forecast.reduce((s, w) => s + w.projectedNet, 0);

  const forecast: CashFlowForecast = {
    companyId,
    generatedAt: new Date().toISOString(),
    horizonDays,
    historicalPeriods: historical,
    forecastPeriods: parsed.forecast,
    summary: parsed.summary,
    risks: parsed.risks,
    opportunities: parsed.opportunities,
    currentCashBalance: currentBalance,
    projectedEndBalance,
  };

  forecastCache.set(cacheKey, { data: forecast, expiresAt: Date.now() + 4 * 60 * 60 * 1000 });

  log.info('AI cash flow forecast complete', {
    companyId,
    horizonDays,
    historicalWeeks: historical.length,
    forecastWeeks: parsed.forecast.length,
  }, 'cashFlowForecast');

  return forecast;
}
