/**
 * KPI Scorecard Service — traffic-light scoring of financial KPIs.
 * Pure business logic — no database dependencies.
 */

import type { ExtendedRatioResult } from './reportingEngineService';

export interface KPITargetConfig {
  ratioKey: string;
  target: number;
  warningThreshold: number;
  criticalThreshold: number;
  lowerIsBetter: boolean;
}

export interface KPIScorecardItem {
  ratioKey: string;
  name: string;
  value: number;
  target: number;
  status: 'green' | 'amber' | 'red';
  percentOfTarget: number;
}

// Human-readable names for ratio keys
const RATIO_NAMES: Record<string, string> = {
  grossProfitMargin: 'Gross Profit Margin',
  netProfitMargin: 'Net Profit Margin',
  operatingProfitMargin: 'Operating Profit Margin',
  currentRatio: 'Current Ratio',
  quickRatio: 'Quick Ratio',
  debtToEquity: 'Debt-to-Equity',
  returnOnAssets: 'Return on Assets',
  returnOnEquity: 'Return on Equity',
  debtorDays: 'Debtor Days',
  creditorDays: 'Creditor Days',
  inventoryTurnover: 'Inventory Turnover',
  ebitdaMargin: 'EBITDA Margin',
  roce: 'ROCE',
  interestCoverage: 'Interest Coverage',
  debtRatio: 'Debt Ratio',
  equityMultiplier: 'Equity Multiplier',
  cashRatio: 'Cash Ratio',
  workingCapital: 'Working Capital',
  operatingCashFlowRatio: 'Operating CF Ratio',
  assetTurnover: 'Asset Turnover',
  receivablesTurnover: 'Receivables Turnover',
  payablesTurnover: 'Payables Turnover',
  inventoryDays: 'Inventory Days',
  cashConversionCycle: 'Cash Conversion Cycle',
  freeCashFlow: 'Free Cash Flow',
  revenuePerEmployee: 'Revenue per Employee',
};

/**
 * Build a KPI scorecard from ratio results and target configuration.
 */
export function buildKPIScorecard(
  ratios: ExtendedRatioResult,
  targets: KPITargetConfig[],
): KPIScorecardItem[] {
  return targets.map(config => {
    const value = (ratios as unknown as Record<string, unknown>)[config.ratioKey];
    const numValue = typeof value === 'number' ? value : 0;

    const percentOfTarget = config.target !== 0
      ? Math.round((numValue / config.target) * 10000) / 100
      : 0;

    const status = scoreStatus(numValue, config);

    return {
      ratioKey: config.ratioKey,
      name: RATIO_NAMES[config.ratioKey] || config.ratioKey,
      value: numValue,
      target: config.target,
      status,
      percentOfTarget,
    };
  });
}

function scoreStatus(
  value: number,
  config: KPITargetConfig,
): 'green' | 'amber' | 'red' {
  if (config.lowerIsBetter) {
    // Lower is better: below target = green, above warning = amber, above critical = red
    if (value <= config.target) return 'green';
    if (value <= config.warningThreshold) return 'amber';
    return 'red';
  }

  // Higher is better: above target = green, above warning = amber, below critical = red
  if (value >= config.target) return 'green';
  if (value >= config.warningThreshold) return 'amber';
  return 'red';
}
