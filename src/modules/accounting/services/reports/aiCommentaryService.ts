/**
 * AI Commentary Service — Key drivers, risk assessment, executive summary.
 * Pure business logic — no database dependencies.
 */

export interface ManagementPackData {
  companyName: string;
  period: string;
  incomeStatement: { revenue: number; costOfSales: number; grossProfit: number; operatingExpenses: number; netProfit: number };
  balanceSheet: { totalAssets: number; totalLiabilities: number; equity: number; currentRatio: number; debtEquityRatio: number };
  priorPeriod?: { revenue: number; costOfSales: number; grossProfit: number; operatingExpenses: number; netProfit: number };
  ratios: { grossMargin: number; netMargin: number; currentRatio: number; quickRatio: number };
}

export interface KeyDriver {
  metric: string;
  change: number;
  changePercent: number;
  direction: 'up' | 'down' | 'flat';
  explanation: string;
}

export interface RiskArea {
  area: string;
  severity: 'high' | 'medium' | 'low';
  description: string;
}

export interface ExecutiveSummary {
  profitDirection: 'up' | 'down' | 'flat';
  revenueGrowthPercent: number;
  grossMarginPercent: number;
  netProfitAmount: number;
}

export function identifyKeyDrivers(
  current: ManagementPackData['incomeStatement'],
  prior: ManagementPackData['incomeStatement'],
): KeyDriver[] {
  const metrics: Array<{ metric: string; current: number; prior: number; label: string }> = [
    { metric: 'revenue', current: current.revenue, prior: prior.revenue, label: 'Revenue' },
    { metric: 'costOfSales', current: current.costOfSales, prior: prior.costOfSales, label: 'Cost of Sales' },
    { metric: 'grossProfit', current: current.grossProfit, prior: prior.grossProfit, label: 'Gross Profit' },
    { metric: 'operatingExpenses', current: current.operatingExpenses, prior: prior.operatingExpenses, label: 'Operating Expenses' },
    { metric: 'netProfit', current: current.netProfit, prior: prior.netProfit, label: 'Net Profit' },
  ];

  const drivers: KeyDriver[] = metrics.map(m => {
    const change = Math.round((m.current - m.prior) * 100) / 100;
    const changePercent = m.prior !== 0 ? Math.round((change / Math.abs(m.prior)) * 10000) / 100 : 0;
    const direction: KeyDriver['direction'] = Math.abs(changePercent) < 1 ? 'flat' : change > 0 ? 'up' : 'down';

    return {
      metric: m.metric,
      change,
      changePercent,
      direction,
      explanation: `${m.label} ${direction === 'up' ? 'increased' : direction === 'down' ? 'decreased' : 'remained flat'} by ${Math.abs(changePercent).toFixed(1)}%`,
    };
  });

  return drivers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}

export function assessRiskAreas(data: ManagementPackData): RiskArea[] {
  const risks: RiskArea[] = [];

  if (data.balanceSheet.currentRatio < 1.0) {
    risks.push({ area: 'Liquidity Crisis', severity: 'high', description: `Current ratio ${data.balanceSheet.currentRatio.toFixed(2)} is below 1.0 — unable to cover short-term obligations` });
  } else if (data.balanceSheet.currentRatio < 1.5) {
    risks.push({ area: 'Liquidity Pressure', severity: 'medium', description: `Current ratio ${data.balanceSheet.currentRatio.toFixed(2)} is below recommended 1.5` });
  }

  if (data.balanceSheet.debtEquityRatio > 2.0) {
    risks.push({ area: 'Leverage Risk', severity: 'medium', description: `Debt-to-equity ${data.balanceSheet.debtEquityRatio.toFixed(2)} exceeds 2.0 — high financial leverage` });
  } else if (data.balanceSheet.debtEquityRatio > 3.0) {
    risks.push({ area: 'Leverage Crisis', severity: 'high', description: `Debt-to-equity ${data.balanceSheet.debtEquityRatio.toFixed(2)} exceeds 3.0` });
  }

  if (data.ratios.grossMargin < 20) {
    risks.push({ area: 'Margin Pressure', severity: 'medium', description: `Gross margin ${data.ratios.grossMargin.toFixed(1)}% is below 20%` });
  }

  if (data.ratios.netMargin < 5) {
    risks.push({ area: 'Profitability Risk', severity: 'medium', description: `Net margin ${data.ratios.netMargin.toFixed(1)}% is below 5%` });
  }

  return risks;
}

export function buildExecutiveSummary(data: ManagementPackData): ExecutiveSummary {
  const revenueGrowth = data.priorPeriod
    ? (data.priorPeriod.revenue !== 0 ? Math.round(((data.incomeStatement.revenue - data.priorPeriod.revenue) / Math.abs(data.priorPeriod.revenue)) * 10000) / 100 : 0)
    : 0;

  const profitChange = data.priorPeriod
    ? data.incomeStatement.netProfit - data.priorPeriod.netProfit
    : 0;

  return {
    profitDirection: Math.abs(profitChange) < 100 ? 'flat' : profitChange > 0 ? 'up' : 'down',
    revenueGrowthPercent: revenueGrowth,
    grossMarginPercent: data.ratios.grossMargin,
    netProfitAmount: data.incomeStatement.netProfit,
  };
}
