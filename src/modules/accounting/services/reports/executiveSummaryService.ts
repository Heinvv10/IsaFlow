/**
 * Executive Summary Service
 * Builds a concise executive dashboard summary from financial data.
 * Pure business logic — no database dependencies.
 */

export interface ExecutiveSummaryInput {
  period: string;
  companyName: string;
  revenue: number;
  costOfSales: number;
  operatingExpenses: number;
  netProfit: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  currentAssets: number;
  currentLiabilities: number;
  cash: number;
  accountsReceivable: number;
  accountsPayable: number;
  inventory: number;
  priorRevenue?: number;
  priorNetProfit?: number;
}

export interface ExecutiveKPIs {
  revenue: number;
  netProfit: number;
  grossProfitMargin: number;
  netProfitMargin: number;
  revenueGrowth: number;
  profitGrowth: number;
  currentRatio: number;
  debtToEquity: number;
  cashBalance: number;
}

export interface CashPositionSummary {
  cashBalance: number;
  accountsReceivable: number;
  accountsPayable: number;
  netWorkingCapital: number;
  currentRatio: number;
}

export interface ExecutiveHighlight {
  type: 'positive' | 'negative' | 'neutral';
  message: string;
}

export interface ExecutiveAlert {
  severity: 'info' | 'warning' | 'danger';
  message: string;
}

export interface ExecutiveSummary {
  period: string;
  companyName: string;
  kpis: ExecutiveKPIs;
  cashPosition: CashPositionSummary;
  highlights: ExecutiveHighlight[];
  alerts: ExecutiveAlert[];
  generatedAt: string;
}

function safeDiv(n: number, d: number): number {
  return d === 0 ? 0 : n / d;
}

function pct(n: number, d: number): number {
  return Math.round(safeDiv(n, d) * 10000) / 100;
}

function growthRate(current: number, prior: number): number {
  if (prior === 0) return 0;
  return Math.round(((current - prior) / prior) * 10000) / 100;
}

export function generateHighlights(input: ExecutiveSummaryInput): ExecutiveHighlight[] {
  const highlights: ExecutiveHighlight[] = [];
  const grossProfit = input.revenue - input.costOfSales;
  const grossMargin = pct(grossProfit, input.revenue);
  const netMargin = pct(input.netProfit, input.revenue);

  if (input.priorRevenue && input.priorRevenue > 0) {
    const revGrowth = growthRate(input.revenue, input.priorRevenue);
    if (revGrowth > 0) {
      highlights.push({ type: 'positive', message: `Revenue grew ${revGrowth.toFixed(1)}% vs prior period` });
    } else if (revGrowth < 0) {
      highlights.push({ type: 'negative', message: `Revenue declined ${Math.abs(revGrowth).toFixed(1)}% vs prior period` });
    }
  }

  if (grossMargin >= 40) {
    highlights.push({ type: 'positive', message: `Strong gross margin of ${grossMargin.toFixed(1)}%` });
  } else if (grossMargin < 20) {
    highlights.push({ type: 'negative', message: `Low gross margin of ${grossMargin.toFixed(1)}% — review cost structure` });
  }

  if (netMargin >= 15) {
    highlights.push({ type: 'positive', message: `Healthy net profit margin of ${netMargin.toFixed(1)}%` });
  } else if (netMargin < 5 && netMargin >= 0) {
    highlights.push({ type: 'neutral', message: `Thin net margin of ${netMargin.toFixed(1)}% — monitor closely` });
  }

  const currentRatio = safeDiv(input.currentAssets, input.currentLiabilities);
  if (currentRatio >= 2.0) {
    highlights.push({ type: 'positive', message: `Strong liquidity with current ratio of ${currentRatio.toFixed(2)}` });
  } else if (currentRatio < 1.0) {
    highlights.push({ type: 'negative', message: `Liquidity risk — current ratio below 1.0 at ${currentRatio.toFixed(2)}` });
  }

  if (highlights.length === 0) {
    highlights.push({ type: 'neutral', message: 'Financial performance in line with expectations' });
  }

  return highlights;
}

export function summarizeCashPosition(input: ExecutiveSummaryInput): CashPositionSummary {
  return {
    cashBalance: input.cash,
    accountsReceivable: input.accountsReceivable,
    accountsPayable: input.accountsPayable,
    netWorkingCapital: input.currentAssets - input.currentLiabilities,
    currentRatio: Math.round(safeDiv(input.currentAssets, input.currentLiabilities) * 100) / 100,
  };
}

export function generateAlerts(input: ExecutiveSummaryInput): ExecutiveAlert[] {
  const alerts: ExecutiveAlert[] = [];

  if (input.netProfit < 0) {
    alerts.push({ severity: 'danger', message: `Net loss of R ${Math.abs(input.netProfit).toLocaleString('en-ZA')} reported this period` });
  }

  const currentRatio = safeDiv(input.currentAssets, input.currentLiabilities);
  if (currentRatio < 1.0) {
    alerts.push({ severity: 'danger', message: `Current ratio ${currentRatio.toFixed(2)} — current liabilities exceed current assets` });
  } else if (currentRatio < 1.2) {
    alerts.push({ severity: 'warning', message: `Current ratio ${currentRatio.toFixed(2)} is below recommended minimum of 1.2` });
  }

  if (input.cash <= 0) {
    alerts.push({ severity: 'danger', message: 'Cash balance is zero or negative — immediate action required' });
  } else if (input.currentLiabilities > 0 && input.cash < input.currentLiabilities * 0.1) {
    alerts.push({ severity: 'warning', message: 'Cash balance is very low relative to current liabilities' });
  }

  const debtToEquity = safeDiv(input.totalLiabilities, input.totalEquity);
  if (debtToEquity > 2.0) {
    alerts.push({ severity: 'warning', message: `High leverage — debt-to-equity ratio at ${debtToEquity.toFixed(2)}` });
  }

  if (input.priorNetProfit && input.priorNetProfit > 0) {
    const profitChange = growthRate(input.netProfit, input.priorNetProfit);
    if (profitChange < -20) {
      alerts.push({ severity: 'warning', message: `Net profit declined ${Math.abs(profitChange).toFixed(1)}% vs prior period` });
    }
  }

  return alerts;
}

export function buildExecutiveSummary(
  input: ExecutiveSummaryInput,
  _from: string,
  _to: string,
): ExecutiveSummary {
  const grossProfit = input.revenue - input.costOfSales;
  const revenueGrowth = input.priorRevenue ? growthRate(input.revenue, input.priorRevenue) : 0;
  const profitGrowth = input.priorNetProfit ? growthRate(input.netProfit, input.priorNetProfit) : 0;

  const kpis: ExecutiveKPIs = {
    revenue: input.revenue,
    netProfit: input.netProfit,
    grossProfitMargin: pct(grossProfit, input.revenue),
    netProfitMargin: pct(input.netProfit, input.revenue),
    revenueGrowth,
    profitGrowth,
    currentRatio: Math.round(safeDiv(input.currentAssets, input.currentLiabilities) * 100) / 100,
    debtToEquity: Math.round(safeDiv(input.totalLiabilities, input.totalEquity) * 100) / 100,
    cashBalance: input.cash,
  };

  return {
    period: input.period,
    companyName: input.companyName,
    kpis,
    cashPosition: summarizeCashPosition(input),
    highlights: generateHighlights(input),
    alerts: generateAlerts(input),
    generatedAt: new Date().toISOString(),
  };
}
