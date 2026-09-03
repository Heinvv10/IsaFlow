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
  /** null when the ratio could not be computed — see `reason`. */
  value: number | null;
  target: number;
  status: 'green' | 'amber' | 'red' | 'not_meaningful';
  /** Why the ratio could not be scored. Present only when status is not_meaningful. */
  reason?: string;
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
  // AFS Master v15 additions
  pbitMargin: 'PBIT Margin',
  directMaterialMargin: 'Direct Material Margin',
  netOperatingAssetTurnover: 'Net Operating Asset Turnover',
  ebitdaToNetInterest: 'EBITDA / Net Interest',
  pbtToNetInterest: 'PBT / Net Interest',
  netProfitToNetInterest: 'Net Profit / Net Interest',
  pbitPerEmployee: 'PBIT per Employee',
  ebitdaPerEmployee: 'EBITDA per Employee',
  employeeCostToRevenue: 'Employee Cost / Revenue',
  employeeCostPerHead: 'Employee Cost per Head',
  dividendCover: 'Dividend Cover',
  retentionRate: 'Retention Rate',
  effectiveTaxRate: 'Effective Tax Rate',
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
    // A ratio the engine could not compute is null, and coercing that to 0 is
    // how AN-07 scored an insolvent company green: debt-to-equity is
    // lowerIsBetter, so 0 beat every target. Report it as unscored instead.
    const reason = ratios.notMeaningful?.[config.ratioKey];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return {
        ratioKey: config.ratioKey,
        name: RATIO_NAMES[config.ratioKey] || config.ratioKey,
        value: null,
        target: config.target,
        percentOfTarget: 0,
        status: 'not_meaningful' as const,
        reason: reason ?? 'This ratio could not be computed from the available figures.',
      };
    }
    const numValue = value;

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
