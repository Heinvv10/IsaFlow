/**
 * Report Pack Service
 * Assembles ordered report sections for Board, Management, and Monthly packs.
 * Pure business logic — no database dependencies.
 */

import { calculateExtendedRatios, type FinancialData } from './reportingEngineService';
import { buildKPIScorecard, type KPITargetConfig } from './kpiScorecardService';
import { buildProfitWaterfall } from './waterfallDataService';
import { marginPct2dp } from './marginPct';

export interface ReportPackInput {
  companyName: string;
  period: string;
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
  operatingCashFlow?: number;
  capitalExpenditure?: number;
  otherIncome?: number;
  otherExpenses?: number;
  /** From the classifier. Falls back to the derived line when absent. */
  operatingProfit?: number;
  financingCashFlow?: number;
}

export type PackType = 'board' | 'management' | 'monthly';

export interface PackSectionConfig {
  type: string;
  title: string;
}

export interface PackSection {
  type: string;
  title: string;
  data: Record<string, unknown>;
}

export interface ReportPack {
  type: PackType;
  companyName: string;
  period: string;
  generatedAt: string;
  sections: PackSection[];
}

const BOARD_SECTIONS: PackSectionConfig[] = [
  { type: 'income_statement', title: 'Income Statement' },
  { type: 'balance_sheet', title: 'Balance Sheet' },
  { type: 'ratios', title: 'Financial Ratios' },
  { type: 'kpis', title: 'KPI Scorecard' },
  { type: 'commentary', title: 'Commentary' },
];

const MANAGEMENT_SECTIONS: PackSectionConfig[] = [
  { type: 'income_statement', title: 'Income Statement' },
  { type: 'balance_sheet', title: 'Balance Sheet' },
  { type: 'cash_flow', title: 'Cash Flow' },
  { type: 'ratios', title: 'Financial Ratios' },
  { type: 'kpis', title: 'KPI Scorecard' },
  { type: 'waterfall', title: 'Profit Waterfall' },
  { type: 'trends', title: 'Trend Analysis' },
  { type: 'commentary', title: 'Commentary' },
];

const MONTHLY_SECTIONS: PackSectionConfig[] = [
  { type: 'income_statement', title: 'Income Statement' },
  { type: 'balance_sheet', title: 'Balance Sheet' },
  { type: 'cash_flow', title: 'Cash Flow' },
  { type: 'ratios', title: 'Financial Ratios' },
];

export function getPackTemplate(type: PackType): PackSectionConfig[] {
  switch (type) {
    case 'board': return BOARD_SECTIONS;
    case 'management': return MANAGEMENT_SECTIONS;
    case 'monthly': return MONTHLY_SECTIONS;
  }
}

const DEFAULT_KPI_TARGETS: KPITargetConfig[] = [
  { ratioKey: 'grossProfitMargin', target: 35, warningThreshold: 25, criticalThreshold: 15, lowerIsBetter: false },
  { ratioKey: 'netProfitMargin', target: 15, warningThreshold: 10, criticalThreshold: 5, lowerIsBetter: false },
  { ratioKey: 'currentRatio', target: 1.5, warningThreshold: 1.2, criticalThreshold: 1.0, lowerIsBetter: false },
  { ratioKey: 'debtToEquity', target: 0.5, warningThreshold: 1.0, criticalThreshold: 2.0, lowerIsBetter: true },
  { ratioKey: 'debtorDays', target: 30, warningThreshold: 45, criticalThreshold: 60, lowerIsBetter: true },
];

function buildSectionData(
  type: string,
  input: ReportPackInput,
  financialData: FinancialData,
): Record<string, unknown> {
  const grossProfit = input.revenue - input.costOfSales;

  switch (type) {
    case 'income_statement': {
      // Every band, so the pack FOOTS. `revenue` and `operatingExpenses` come
      // from the classifier (turnover only; finance cost and tax excluded)
      // while `netProfit` is the full bottom line — so without these two lines
      // Revenue - CoS - OpEx misses Net Profit by exactly otherIncome minus
      // otherExpenses, R341,712.00 on Brightsphere, on a PDF sent to a client.
      const otherIncome = input.otherIncome ?? 0;
      const otherExpenses = input.otherExpenses ?? 0;
      const operatingProfit =
        input.operatingProfit ?? grossProfit + otherIncome - input.operatingExpenses;
      return {
        revenue: input.revenue,
        costOfSales: input.costOfSales,
        grossProfit,
        otherIncome,
        operatingExpenses: input.operatingExpenses,
        operatingProfit,
        otherExpenses,
        netProfit: input.netProfit,
        // `?? 0` here, not in marginPct: the pack has always printed 0.00%
        // on no turnover and this change must not move a single figure.
        grossMargin: marginPct2dp(grossProfit, input.revenue) ?? 0,
        netMargin: marginPct2dp(input.netProfit, input.revenue) ?? 0,
      };
    }

    case 'balance_sheet':
      return {
        currentAssets: input.currentAssets,
        totalAssets: input.totalAssets,
        currentLiabilities: input.currentLiabilities,
        totalLiabilities: input.totalLiabilities,
        totalEquity: input.totalEquity,
        cash: input.cash,
        accountsReceivable: input.accountsReceivable,
        accountsPayable: input.accountsPayable,
      };

    case 'cash_flow': {
      const opCF = input.operatingCashFlow ?? input.netProfit;
      const capex = input.capitalExpenditure ?? 0;
      const finCF = input.financingCashFlow ?? 0;
      const netCF = opCF - capex + finCF;
      return {
        operatingCashFlow: opCF,
        investingCashFlow: -capex,
        financingCashFlow: finCF,
        netCashFlow: netCF,
        openingCash: input.cash - netCF,
        closingCash: input.cash,
      };
    }

    case 'ratios':
      return calculateExtendedRatios(financialData) as unknown as Record<string, unknown>;

    case 'kpis': {
      const ratios = calculateExtendedRatios(financialData);
      const scorecard = buildKPIScorecard(ratios, DEFAULT_KPI_TARGETS);
      return { scorecard };
    }

    case 'waterfall': {
      const steps = buildProfitWaterfall({
        revenue: input.revenue,
        costOfSales: input.costOfSales,
        grossProfit,
        operatingExpenses: input.operatingExpenses,
        otherIncome: input.otherIncome ?? 0,
        otherExpenses: input.otherExpenses ?? 0,
        netProfit: input.netProfit,
      });
      return { steps };
    }

    case 'trends': {
      // Single-period snapshot — multi-period trends require historical data from API layer
      const gm = input.revenue > 0 ? Math.round((grossProfit / input.revenue) * 10000) / 100 : 0;
      const nm = input.revenue > 0 ? Math.round((input.netProfit / input.revenue) * 10000) / 100 : 0;
      const cr = input.currentLiabilities > 0 ? Math.round((input.currentAssets / input.currentLiabilities) * 100) / 100 : 0;
      return {
        currentPeriod: {
          revenue: input.revenue,
          grossProfit,
          netProfit: input.netProfit,
          grossMargin: gm,
          netMargin: nm,
          currentRatio: cr,
        },
      };
    }

    case 'commentary':
      return {
        period: input.period,
        companyName: input.companyName,
        summary: `${input.companyName} reported revenue of R ${input.revenue.toLocaleString('en-ZA')} with a net profit margin of ${input.revenue > 0 ? Math.round((input.netProfit / input.revenue) * 100) : 0}%.`,
      };

    default:
      return {};
  }
}

export function buildReportPack(
  type: PackType,
  data: ReportPackInput,
  from: string,
  to: string,
): ReportPack {
  const template = getPackTemplate(type);

  const financialData: FinancialData = {
    revenue: data.revenue,
    costOfSales: data.costOfSales,
    operatingExpenses: data.operatingExpenses,
    // Carried, so the pack's ratios use the same operating line as every other
    // surface rather than re-deriving one without other income.
    operatingProfit: data.operatingProfit,
    otherIncome: data.otherIncome,
    netProfit: data.netProfit,
    totalAssets: data.totalAssets,
    totalLiabilities: data.totalLiabilities,
    totalEquity: data.totalEquity,
    currentAssets: data.currentAssets,
    currentLiabilities: data.currentLiabilities,
    inventory: data.inventory,
    accountsReceivable: data.accountsReceivable,
    accountsPayable: data.accountsPayable,
    cash: data.cash,
    operatingCashFlow: data.operatingCashFlow,
    capitalExpenditure: data.capitalExpenditure,
  };

  const sections: PackSection[] = template.map(config => ({
    type: config.type,
    title: config.title,
    data: buildSectionData(config.type, data, financialData),
  }));

  return {
    type,
    companyName: data.companyName,
    period: `${from} to ${to}`,
    generatedAt: new Date().toISOString(),
    sections,
  };
}
