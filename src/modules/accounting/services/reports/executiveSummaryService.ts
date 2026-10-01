/**
 * Executive Summary Service
 * Builds a concise executive dashboard summary from financial data.
 * Pure business logic — no database dependencies.
 *
 * THE PROSE WRITES ITS FIGURES AS THE PACK DOES. It used `toFixed` and
 * `toLocaleString` — "Low gross margin of -1310.8%", "current ratio below 1.0
 * at -0.14", "Net loss of R 1544240.9" — and took margins on zero or negative
 * revenue. Margins and ratios in a sentence now come from the ratio engine
 * (not stated where it says so, with its reason); a percentage carries its
 * sign in a word (`pctWithWord`); money and ratios use the pack's notation.
 * The numeric `kpis` are unchanged.
 */
import { formatMoney, inProse, pctWithWord } from '@/lib/format/money';
import { calculateFinancialRatios } from './ratioCalculations';
import { formatRatioOf } from './ratioPresentation';

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

/** The engine's ratios on this input: null where there is no meaning. */
function engineRatios(input: ExecutiveSummaryInput) {
  return calculateFinancialRatios({ ...input, otherIncome: 0 });
}

const level = (pct: number): string => pctWithWord(pct, 'a positive', 'a negative');
const ratio = (key: string, value: number): string => formatRatioOf(key, value);

export function generateHighlights(input: ExecutiveSummaryInput): ExecutiveHighlight[] {
  const highlights: ExecutiveHighlight[] = [];
  const ratios = engineRatios(input);
  const grossMargin = ratios.grossProfitMargin;
  const netMargin = ratios.netProfitMargin;

  if (input.priorRevenue && input.priorRevenue > 0) {
    const revGrowth = growthRate(input.revenue, input.priorRevenue);
    if (revGrowth > 0) {
      highlights.push({ type: 'positive', message: `Revenue ${pctWithWord(revGrowth, 'grew', 'declined')} vs prior period` });
    } else if (revGrowth < 0) {
      highlights.push({ type: 'negative', message: `Revenue ${pctWithWord(revGrowth, 'grew', 'declined')} vs prior period` });
    }
  }

  if (grossMargin === null || netMargin === null) {
    // The engine's own sentence: on non-positive revenue there is no margin.
    const reason = ratios.notMeaningful.grossProfitMargin ?? ratios.notMeaningful.netProfitMargin;
    highlights.push({ type: 'neutral', message: `Margins are not stated: ${reason}` });
  } else {
    if (grossMargin >= 40) {
      highlights.push({ type: 'positive', message: `Gross margin is ${level(grossMargin)} — strong` });
    } else if (grossMargin < 20) {
      highlights.push({ type: 'negative', message: `Gross margin is ${level(grossMargin)} — review cost structure` });
    }
    if (netMargin >= 15) {
      highlights.push({ type: 'positive', message: `Net profit margin is ${level(netMargin)} — healthy` });
    } else if (netMargin < 5 && netMargin >= 0) {
      highlights.push({ type: 'neutral', message: `Net profit margin is ${level(netMargin)} — thin, monitor closely` });
    }
  }

  const currentRatio = ratios.currentRatio;
  if (currentRatio !== null && currentRatio >= 2.0) {
    highlights.push({ type: 'positive', message: `Current ratio is ${ratio('currentRatio', currentRatio)} — strong liquidity` });
  } else if (currentRatio !== null && currentRatio < 1.0) {
    highlights.push({
      type: 'negative',
      message: `Current ratio is ${ratio('currentRatio', currentRatio)}, below ${ratio('currentRatio', 1)} — liquidity risk`,
    });
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
    // The sign is in the word "loss", so the amount is its size.
    const loss = inProse(formatMoney(Math.abs(input.netProfit), { cents: true, symbol: true, pack: true }));
    alerts.push({ severity: 'danger', message: `Net loss of ${loss} reported this period` });
  }

  // No current liabilities is no current ratio, not a ratio of 0.00 under 1.
  const ratios = engineRatios(input);
  const currentRatio = ratios.currentRatio;
  if (currentRatio !== null && currentRatio < 1.0) {
    alerts.push({ severity: 'danger', message: `Current ratio ${ratio('currentRatio', currentRatio)} — current liabilities exceed current assets` });
  } else if (currentRatio !== null && currentRatio < 1.2) {
    alerts.push({
      severity: 'warning',
      message: `Current ratio ${ratio('currentRatio', currentRatio)} is below recommended minimum of ${ratio('currentRatio', 1.2)}`,
    });
  }

  if (input.cash <= 0) {
    alerts.push({ severity: 'danger', message: 'Cash balance is zero or negative — immediate action required' });
  } else if (input.currentLiabilities > 0 && input.cash < input.currentLiabilities * 0.1) {
    alerts.push({ severity: 'warning', message: 'Cash balance is very low relative to current liabilities' });
  }

  const debtToEquity = ratios.debtToEquity;
  if (debtToEquity !== null && debtToEquity > 2.0) {
    alerts.push({ severity: 'warning', message: `High leverage — debt-to-equity ratio at ${ratio('debtToEquity', debtToEquity)}` });
  }

  if (input.priorNetProfit && input.priorNetProfit > 0) {
    const profitChange = growthRate(input.netProfit, input.priorNetProfit);
    if (profitChange < -20) {
      alerts.push({ severity: 'warning', message: `Net profit ${pctWithWord(profitChange, 'rose', 'declined')} vs prior period` });
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
