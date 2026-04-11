/**
 * Cash Flow Forecast Service
 * Gathers actual bank transaction data and generates AI-powered cash flow forecasts.
 * Also exports legacy helpers used by the existing cash-flow-forecast API route.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/lib/neon';

// ── New AI Forecast Types ────────────────────────────────────────────────────

export interface CashFlowPeriod {
  weekStart: string;
  inflows: number;
  outflows: number;
  netFlow: number;
  runningBalance: number;
}

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

// ── Legacy Types (kept for backward compatibility) ────────────────────────────

export interface CashFlowForecastPoint {
  date: string;
  label: string;
  projectedInflow: number;
  projectedOutflow: number;
  projectedNet: number;
  projectedBalance: number;
  confidence: number;
}

export interface CashFlowAlert {
  type: 'warning' | 'danger';
  message: string;
  date: string;
  projectedBalance: number;
}

export interface CashFlowForecastResult {
  currentBalance: number;
  forecastPoints: CashFlowForecastPoint[];
  alerts: CashFlowAlert[];
  assumptions: string[];
  generatedAt: string;
}

export interface HistoricalCashFlow {
  month: string;
  inflow: number;
  outflow: number;
  net: number;
}

// ── Historical Analysis ──────────────────────────────────────────────────────

/** Get current total cash balance across all bank accounts */
async function getCurrentCashBalance(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(
      CASE WHEN ga.account_subtype IN ('bank', 'cash')
        THEN COALESCE(
          (SELECT SUM(jl.debit) - SUM(jl.credit)
           FROM gl_journal_lines jl
           JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
           WHERE jl.gl_account_id = ga.id
             AND je.status = 'posted'
             AND je.company_id = ${companyId}),
          0)
        ELSE 0
      END
    ), 0) AS total_cash
    FROM gl_accounts ga
    WHERE ga.company_id = ${companyId}
      AND ga.account_type = 'asset'
      AND ga.account_subtype IN ('bank', 'cash')
      AND ga.is_active = true
  `) as Record<string, unknown>[];
  return Number(rows[0]?.total_cash ?? 0);
}

/** Get monthly cash inflows and outflows for the last N months */
async function getHistoricalCashFlows(companyId: string, months: number): Promise<HistoricalCashFlow[]> {
  // Compute the start date in JS to avoid interval arithmetic in tagged templates
  const startDate = new Date();
  startDate.setMonth(startDate.getMonth() - months);
  const startStr = startDate.toISOString().split('T')[0]!;

  const rows = (await sql`
    WITH monthly AS (
      SELECT
        date_trunc('month', je.entry_date) AS month,
        COALESCE(SUM(CASE WHEN jl.debit > 0 AND ga.account_subtype IN ('bank', 'cash') THEN jl.debit ELSE 0 END), 0) AS inflow,
        COALESCE(SUM(CASE WHEN jl.credit > 0 AND ga.account_subtype IN ('bank', 'cash') THEN jl.credit ELSE 0 END), 0) AS outflow
      FROM gl_journal_lines jl
      JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.company_id = ${companyId}
        AND je.status = 'posted'
        AND ga.account_type = 'asset'
        AND ga.account_subtype IN ('bank', 'cash')
        AND je.entry_date >= ${startStr}::DATE
      GROUP BY date_trunc('month', je.entry_date)
    )
    SELECT
      to_char(month, 'YYYY-MM') AS month,
      inflow,
      outflow,
      (inflow - outflow) AS net
    FROM monthly
    ORDER BY month ASC
  `) as Record<string, unknown>[];

  return rows.map((r: Record<string, unknown>) => ({
    month: String(r.month),
    inflow: Number(r.inflow),
    outflow: Number(r.outflow),
    net: Number(r.net),
  }));
}

/** Get known future receivables (unpaid customer invoices) */
async function getExpectedReceivables(companyId: string): Promise<Array<{ dueDate: string; amount: number }>> {
  const rows = (await sql`
    SELECT due_date, SUM(total_amount - COALESCE(amount_paid, 0)) AS amount_due
    FROM customer_invoices
    WHERE company_id = ${companyId}
      AND status IN ('sent', 'overdue', 'approved')
      AND due_date >= CURRENT_DATE
      AND (total_amount - COALESCE(amount_paid, 0)) > 0
    GROUP BY due_date
    ORDER BY due_date ASC
  `) as Record<string, unknown>[];

  return rows.map((r: Record<string, unknown>) => ({
    dueDate: String(r.due_date),
    amount: Number(r.amount_due),
  }));
}

/** Get known future payables (unpaid supplier invoices) */
async function getExpectedPayables(companyId: string): Promise<Array<{ dueDate: string; amount: number }>> {
  const rows = (await sql`
    SELECT due_date, SUM(total_amount - COALESCE(amount_paid, 0)) AS amount_due
    FROM supplier_invoices
    WHERE company_id = ${companyId}
      AND status IN ('approved', 'received', 'overdue')
      AND due_date >= CURRENT_DATE
      AND (total_amount - COALESCE(amount_paid, 0)) > 0
    GROUP BY due_date
    ORDER BY due_date ASC
  `) as Record<string, unknown>[];

  return rows.map((r: Record<string, unknown>) => ({
    dueDate: String(r.due_date),
    amount: Number(r.amount_due),
  }));
}

/** Get recurring invoice amounts for projection */
async function getRecurringRevenue(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(total_amount), 0) AS monthly_recurring
    FROM recurring_invoices
    WHERE company_id = ${companyId}
      AND status = 'active'
      AND frequency = 'monthly'
  `) as Record<string, unknown>[];
  return Number(rows[0]?.monthly_recurring ?? 0);
}

// ── Forecasting Engine ───────────────────────────────────────────────────────

/**
 * Generate a cash flow forecast for the next N months.
 * Uses a blend of:
 * 1. Known receivables and payables (high confidence)
 * 2. Recurring invoices (medium-high confidence)
 * 3. Historical average patterns (medium confidence)
 * 4. Seasonal adjustment from same month prior year (lower confidence)
 */
export async function generateForecast(companyId: string, 
  forecastMonths = 6,
  alertThreshold = 0
): Promise<CashFlowForecastResult> {
  const [currentBalance, historical, receivables, payables, recurringRevenue] = await Promise.all([
    getCurrentCashBalance(companyId),
    getHistoricalCashFlows(companyId, 12),
    getExpectedReceivables(companyId),
    getExpectedPayables(companyId),
    getRecurringRevenue(companyId),
  ]);

  // Calculate historical averages
  const avgInflow = historical.length > 0
    ? historical.reduce((sum, h) => sum + h.inflow, 0) / historical.length
    : 0;
  const avgOutflow = historical.length > 0
    ? historical.reduce((sum, h) => sum + h.outflow, 0) / historical.length
    : 0;

  // Build month-by-month forecast
  const forecastPoints: CashFlowForecastPoint[] = [];
  const alerts: CashFlowAlert[] = [];
  let runningBalance = currentBalance;
  const now = new Date();

  for (let i = 1; i <= forecastMonths; i++) {
    const forecastDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const monthStr = forecastDate.toISOString().slice(0, 7); // YYYY-MM
    const monthLabel = forecastDate.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });

    // Known receivables due this month
    const knownInflows = receivables
      .filter(r => String(r.dueDate).startsWith(monthStr))
      .reduce((sum, r) => sum + r.amount, 0);

    // Known payables due this month
    const knownOutflows = payables
      .filter(p => String(p.dueDate).startsWith(monthStr))
      .reduce((sum, p) => sum + p.amount, 0);

    // Projected inflow: known receivables + recurring revenue + historical average for unknowns
    const knownInflowWeight = knownInflows > 0 ? 0.7 : 0;
    const historicalInflowWeight = 1 - knownInflowWeight;
    const projectedInflow = knownInflows + recurringRevenue + (avgInflow * historicalInflowWeight * 0.5);

    // Projected outflow: known payables + historical average for unknowns
    const knownOutflowWeight = knownOutflows > 0 ? 0.7 : 0;
    const historicalOutflowWeight = 1 - knownOutflowWeight;
    const projectedOutflow = knownOutflows + (avgOutflow * historicalOutflowWeight * 0.5);

    const projectedNet = projectedInflow - projectedOutflow;
    runningBalance += projectedNet;

    // Confidence decreases as we project further out
    const baseConfidence = 0.9;
    const decayFactor = 0.1;
    const knownDataBoost = (knownInflows + knownOutflows > 0) ? 0.1 : 0;
    const confidence = Math.max(0.3, baseConfidence - (i * decayFactor) + knownDataBoost);

    forecastPoints.push({
      date: forecastDate.toISOString().slice(0, 10),
      label: monthLabel,
      projectedInflow: Math.round(projectedInflow * 100) / 100,
      projectedOutflow: Math.round(projectedOutflow * 100) / 100,
      projectedNet: Math.round(projectedNet * 100) / 100,
      projectedBalance: Math.round(runningBalance * 100) / 100,
      confidence: Math.round(confidence * 100) / 100,
    });

    // Generate alerts
    if (runningBalance < alertThreshold) {
      alerts.push({
        type: runningBalance < 0 ? 'danger' : 'warning',
        message: runningBalance < 0
          ? `Projected negative cash balance of R ${Math.abs(runningBalance).toLocaleString('en-ZA', { minimumFractionDigits: 2 })} in ${monthLabel}`
          : `Cash balance projected to drop below threshold in ${monthLabel}`,
        date: forecastDate.toISOString().slice(0, 10),
        projectedBalance: Math.round(runningBalance * 100) / 100,
      });
    }
  }

  // Build assumptions list
  const assumptions: string[] = [];
  if (historical.length > 0) {
    assumptions.push(`Based on ${historical.length} months of historical data`);
  } else {
    assumptions.push('Limited historical data — forecast accuracy may be low');
  }
  if (recurringRevenue > 0) {
    assumptions.push(`Includes R ${recurringRevenue.toLocaleString('en-ZA', { minimumFractionDigits: 2 })} monthly recurring revenue`);
  }
  if (receivables.length > 0) {
    const totalAR = receivables.reduce((s, r) => s + r.amount, 0);
    assumptions.push(`${receivables.length} outstanding invoices totalling R ${totalAR.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`);
  }
  if (payables.length > 0) {
    const totalAP = payables.reduce((s, p) => s + p.amount, 0);
    assumptions.push(`${payables.length} outstanding payables totalling R ${totalAP.toLocaleString('en-ZA', { minimumFractionDigits: 2 })}`);
  }
  assumptions.push('Confidence decreases for months further in the future');

  log.info('Cash flow forecast generated', {
    months: forecastMonths,
    currentBalance,
    pointCount: forecastPoints.length,
    alertCount: alerts.length,
  }, 'accounting');

  return {
    currentBalance: Math.round(currentBalance * 100) / 100,
    forecastPoints,
    alerts,
    assumptions,
    generatedAt: new Date().toISOString(),
  };
}

/** Get historical cash flow data for chart display */
export async function getHistoricalForChart(companyId: string, months = 6): Promise<HistoricalCashFlow[]> {
  return getHistoricalCashFlows(companyId, months);
}

// ── AI Cash Flow Forecast (new) ───────────────────────────────────────────────

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

interface ForecastCache {
  data: CashFlowForecast;
  expiresAt: number;
}

const forecastCache = new Map<string, ForecastCache>();

function toNum(val: unknown): number {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') return parseFloat(val) || 0;
  return 0;
}

function toDateStr(val: unknown): string {
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === 'string') return val.slice(0, 10);
  return '';
}

/**
 * Get actual weekly cash flow from bank_transactions for the last N days.
 */
export async function getActualCashFlow(
  companyId: string,
  lookbackDays: number,
): Promise<CashFlowPeriod[]> {
  const rows = (await sql`
    SELECT
      DATE_TRUNC('week', transaction_date)::DATE AS week_start,
      SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END)  AS inflows,
      SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END) AS outflows,
      SUM(amount) AS net_flow
    FROM bank_transactions
    WHERE
      company_id = ${companyId}
      AND transaction_date >= CURRENT_DATE - ${lookbackDays}::INT
      AND status NOT IN ('excluded')
    GROUP BY week_start
    ORDER BY week_start ASC
  `) as DbRow[];

  let running = 0;
  return rows.map((row) => {
    const net = toNum(row['net_flow']);
    running += net;
    return {
      weekStart: toDateStr(row['week_start']),
      inflows: toNum(row['inflows']),
      outflows: toNum(row['outflows']),
      netFlow: net,
      runningBalance: running,
    };
  });
}

async function getBankBalance(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(amount), 0) AS balance
    FROM bank_transactions
    WHERE company_id = ${companyId}
      AND status NOT IN ('excluded')
  `) as DbRow[];
  return toNum(rows[0]?.['balance']);
}

async function getUpcomingReceivablesAndPayables(
  companyId: string,
  horizonDays: number,
): Promise<Array<{ type: 'receivable' | 'payable'; dueDate: string; amount: number; status: string }>> {
  const receivables = (await sql`
    SELECT due_date,
           (total_amount - COALESCE(amount_paid, 0)) AS outstanding,
           status
    FROM customer_invoices
    WHERE company_id = ${companyId}
      AND status IN ('sent', 'overdue', 'partially_paid')
      AND due_date <= CURRENT_DATE + ${horizonDays}::INT
      AND due_date IS NOT NULL
      AND (total_amount - COALESCE(amount_paid, 0)) > 0
    ORDER BY due_date ASC
  `) as DbRow[];

  const payables = (await sql`
    SELECT due_date,
           (total_amount - COALESCE(amount_paid, 0)) AS outstanding,
           status
    FROM supplier_invoices
    WHERE company_id = ${companyId}
      AND status IN ('approved', 'partially_paid')
      AND due_date <= CURRENT_DATE + ${horizonDays}::INT
      AND due_date IS NOT NULL
      AND (total_amount - COALESCE(amount_paid, 0)) > 0
    ORDER BY due_date ASC
  `) as DbRow[];

  return [
    ...receivables.map((r) => ({
      type: 'receivable' as const,
      dueDate: toDateStr(r['due_date']),
      amount: toNum(r['outstanding']),
      status: String(r['status'] ?? ''),
    })),
    ...payables.map((r) => ({
      type: 'payable' as const,
      dueDate: toDateStr(r['due_date']),
      amount: toNum(r['outstanding']),
      status: String(r['status'] ?? ''),
    })),
  ];
}

async function getRecurringTemplates(
  companyId: string,
): Promise<Array<{ name: string; frequency: string; entityType: string; nextRunDate: string | null }>> {
  try {
    const rows = (await sql`
      SELECT name, frequency, entity_type, next_run_date
      FROM recurring_transaction_templates
      WHERE company_id = ${companyId} AND is_active = true
      ORDER BY next_run_date ASC NULLS LAST
      LIMIT 20
    `) as DbRow[];
    return rows.map((r) => ({
      name: String(r['name'] ?? ''),
      frequency: String(r['frequency'] ?? ''),
      entityType: String(r['entity_type'] ?? ''),
      nextRunDate: r['next_run_date'] ? toDateStr(r['next_run_date']) : null,
    }));
  } catch {
    log.warn('recurring_transaction_templates not available, skipping', {}, 'cashFlowForecast');
    return [];
  }
}

function buildWeekStarts(horizonDays: number): string[] {
  const weeks: string[] = [];
  const today = new Date();
  const dow = today.getDay(); // 0=Sun, 1=Mon
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

function buildAIPrompt(
  historical: CashFlowPeriod[],
  upcoming: Array<{ type: 'receivable' | 'payable'; dueDate: string; amount: number; status: string }>,
  recurring: Array<{ name: string; frequency: string; entityType: string; nextRunDate: string | null }>,
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
