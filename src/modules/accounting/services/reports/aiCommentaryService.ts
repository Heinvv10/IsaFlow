/**
 * AI Commentary Service — Key drivers, risk assessment, executive summary.
 * Pure business logic — no database dependencies.
 */

export interface ManagementPackData {
  companyName: string;
  period: string;
  incomeStatement: { revenue: number; costOfSales: number; grossProfit: number; operatingExpenses: number; netProfit: number };
  /** `currentRatio` is null where there are no current liabilities to cover. */
  balanceSheet: { totalAssets: number; totalLiabilities: number; equity: number; currentRatio: number | null; debtEquityRatio: number };
  priorPeriod?: { revenue: number; costOfSales: number; grossProfit: number; operatingExpenses: number; netProfit: number };
  /**
   * Null where the ratio has no base: a margin on revenue that is not
   * positive, a liquidity ratio with no current liabilities. Never 0 standing
   * in for that — a 0% margin and a 0.00 current ratio are both findings, and
   * each fired a risk sentence about a figure nobody measured.
   */
  ratios: { grossMargin: number | null; netMargin: number | null; currentRatio: number | null; quickRatio: number | null };
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
  /** null where revenue is not positive — there is no margin to state. */
  grossMarginPercent: number | null;
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

  // A ratio that could not be measured raises no risk: a risk sentence quotes
  // the figure, and there is none. Each rule below is skipped on a null.
  const currentRatio = data.balanceSheet.currentRatio;
  if (currentRatio !== null && currentRatio < 1.0) {
    risks.push({ area: 'Liquidity Crisis', severity: 'high', description: `Current ratio ${currentRatio.toFixed(2)} is below 1.0 — unable to cover short-term obligations` });
  } else if (currentRatio !== null && currentRatio < 1.5) {
    risks.push({ area: 'Liquidity Pressure', severity: 'medium', description: `Current ratio ${currentRatio.toFixed(2)} is below recommended 1.5` });
  }

  // Descending. Tested the other way round, `> 2.0` matched first and the
  // high-severity branch below was unreachable for every input — so the worst
  // gearing in the book reported as merely medium.
  if (data.balanceSheet.debtEquityRatio > 3.0) {
    risks.push({ area: 'Leverage Crisis', severity: 'high', description: `Debt-to-equity ${data.balanceSheet.debtEquityRatio.toFixed(2)} exceeds 3.0` });
  } else if (data.balanceSheet.debtEquityRatio > 2.0) {
    risks.push({ area: 'Leverage Risk', severity: 'medium', description: `Debt-to-equity ${data.balanceSheet.debtEquityRatio.toFixed(2)} exceeds 2.0 — high financial leverage` });
  }

  const { grossMargin, netMargin } = data.ratios;
  if (grossMargin !== null && grossMargin < 20) {
    risks.push({ area: 'Margin Pressure', severity: 'medium', description: `Gross margin ${grossMargin.toFixed(1)}% is below 20%` });
  }

  if (netMargin !== null && netMargin < 5) {
    risks.push({ area: 'Profitability Risk', severity: 'medium', description: `Net margin ${netMargin.toFixed(1)}% is below 5%` });
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
