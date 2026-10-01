/**
 * AI Commentary Service — Key drivers, risk assessment, executive summary.
 * Pure business logic — no database dependencies.
 */
import { pctWithWord } from '@/lib/format/money';
import { formatRatioOf } from './ratioPresentation';

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

/**
 * A key driver in words. It was `toFixed` — "decreased by 1523.4%", no
 * grouping — and "remained flat by 0.4%"; on a nil prior every change read
 * "remained flat by 0.0%". The percentage goes through `pctWithWord`.
 */
function driverSentence(
  label: string, prior: number, change: number, changePercent: number, direction: KeyDriver['direction'],
): string {
  if (prior === 0 && change !== 0) return `${label} ${change > 0 ? 'increased' : 'decreased'} from nil`;
  if (direction === 'flat') return `${label} remained flat`;
  return `${label} ${pctWithWord(changePercent, 'increased by', 'decreased by')}`;
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
      explanation: driverSentence(m.label, m.prior, change, changePercent, direction),
    };
  });

  return drivers.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));
}

/**
 * A risk sentence's figures, as the pack writes them. They were `toFixed`:
 * "Gross margin -1310.8% is below 20%" — a hyphen for a minus and no
 * grouping. A margin carries its sign in a word; a ratio is in its unit.
 */
const level = (pct: number): string => pctWithWord(pct, 'a positive', 'a negative');
const ratio = (key: string, value: number): string => formatRatioOf(key, value);

export function assessRiskAreas(data: ManagementPackData): RiskArea[] {
  const risks: RiskArea[] = [];

  // A ratio that could not be measured raises no risk: a risk sentence quotes
  // the figure, and there is none. Each rule below is skipped on a null.
  const currentRatio = data.balanceSheet.currentRatio;
  if (currentRatio !== null && currentRatio < 1.0) {
    risks.push({ area: 'Liquidity Crisis', severity: 'high', description: `Current ratio ${ratio('currentRatio', currentRatio)} is below ${ratio('currentRatio', 1)} — unable to cover short-term obligations` });
  } else if (currentRatio !== null && currentRatio < 1.5) {
    risks.push({ area: 'Liquidity Pressure', severity: 'medium', description: `Current ratio ${ratio('currentRatio', currentRatio)} is below recommended ${ratio('currentRatio', 1.5)}` });
  }

  // Descending. Tested the other way round, `> 2.0` matched first and the
  // high-severity branch below was unreachable for every input — so the worst
  // gearing in the book reported as merely medium.
  if (data.balanceSheet.debtEquityRatio > 3.0) {
    risks.push({ area: 'Leverage Crisis', severity: 'high', description: `Debt-to-equity ${ratio('debtToEquity', data.balanceSheet.debtEquityRatio)} exceeds ${ratio('debtToEquity', 3)}` });
  } else if (data.balanceSheet.debtEquityRatio > 2.0) {
    risks.push({ area: 'Leverage Risk', severity: 'medium', description: `Debt-to-equity ${ratio('debtToEquity', data.balanceSheet.debtEquityRatio)} exceeds ${ratio('debtToEquity', 2)} — high financial leverage` });
  }

  const { grossMargin, netMargin } = data.ratios;
  if (grossMargin !== null && grossMargin < 20) {
    risks.push({ area: 'Margin Pressure', severity: 'medium', description: `Gross margin is ${level(grossMargin)}, below ${ratio('grossProfitMargin', 20)}` });
  }

  if (netMargin !== null && netMargin < 5) {
    risks.push({ area: 'Profitability Risk', severity: 'medium', description: `Net margin is ${level(netMargin)}, below ${ratio('netProfitMargin', 5)}` });
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
