/**
 * Cash Flow Forecast Service
 * Orchestration layer — re-exports types and functions from companion modules.
 * Callers import from this file unchanged.
 *
 * Companion modules:
 *   cashFlowForecastDataService.ts  — DB queries
 *   cashFlowForecastAiService.ts    — AI prompt, API call, caching
 */

import { log } from '@/lib/logger';
import {
  getCurrentCashBalance,
  getHistoricalCashFlows,
  getExpectedReceivables,
  getExpectedPayables,
  getRecurringRevenue,
} from './cashFlowForecastDataService';

// ── Re-export everything so existing callers need no changes ──────────────────

export type { CashFlowPeriod, HistoricalCashFlow, UpcomingItem, RecurringTemplate } from './cashFlowForecastDataService';
export { getActualCashFlow } from './cashFlowForecastDataService';
export type { ForecastWeek, CashFlowForecast } from './cashFlowForecastAiService';
export { getForecast } from './cashFlowForecastAiService';

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

// ── Legacy orchestration ──────────────────────────────────────────────────────

/**
 * Generate a cash flow forecast for the next N months.
 * Uses a blend of: known receivables/payables, recurring invoices, historical averages.
 */
export async function generateForecast(
  companyId: string,
  forecastMonths = 6,
  alertThreshold = 0,
): Promise<CashFlowForecastResult> {
  const [currentBalance, historical, receivables, payables, recurringRevenue] = await Promise.all([
    getCurrentCashBalance(companyId),
    getHistoricalCashFlows(companyId, 12),
    getExpectedReceivables(companyId),
    getExpectedPayables(companyId),
    getRecurringRevenue(companyId),
  ]);

  const avgInflow = historical.length > 0
    ? historical.reduce((sum, h) => sum + h.inflow, 0) / historical.length
    : 0;
  const avgOutflow = historical.length > 0
    ? historical.reduce((sum, h) => sum + h.outflow, 0) / historical.length
    : 0;

  const forecastPoints: CashFlowForecastPoint[] = [];
  const alerts: CashFlowAlert[] = [];
  let runningBalance = currentBalance;
  const now = new Date();

  for (let i = 1; i <= forecastMonths; i++) {
    const forecastDate = new Date(now.getFullYear(), now.getMonth() + i, 1);
    const monthStr = forecastDate.toISOString().slice(0, 7);
    const monthLabel = forecastDate.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });

    const knownInflows = receivables
      .filter(r => String(r.dueDate).startsWith(monthStr))
      .reduce((sum, r) => sum + r.amount, 0);

    const knownOutflows = payables
      .filter(p => String(p.dueDate).startsWith(monthStr))
      .reduce((sum, p) => sum + p.amount, 0);

    const knownInflowWeight = knownInflows > 0 ? 0.7 : 0;
    const historicalInflowWeight = 1 - knownInflowWeight;
    const projectedInflow = knownInflows + recurringRevenue + (avgInflow * historicalInflowWeight * 0.5);

    const knownOutflowWeight = knownOutflows > 0 ? 0.7 : 0;
    const historicalOutflowWeight = 1 - knownOutflowWeight;
    const projectedOutflow = knownOutflows + (avgOutflow * historicalOutflowWeight * 0.5);

    const projectedNet = projectedInflow - projectedOutflow;
    runningBalance += projectedNet;

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
export async function getHistoricalForChart(companyId: string, months = 6) {
  return getHistoricalCashFlows(companyId, months);
}
