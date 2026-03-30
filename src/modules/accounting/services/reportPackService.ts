/**
 * Report Pack Service
 * Assembles ordered report sections for Board, Management, and Monthly packs.
 * Pure business logic — no database dependencies.
 */

import { calculateExtendedRatios, type FinancialData } from './reportingEngineService';
import { buildKPIScorecard, type KPITargetConfig } from './kpiScorecardService';
import { buildProfitWaterfall } from './waterfallDataService';

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
    case 'income_statement':
      return {
        revenue: input.revenue,
        costOfSales: input.costOfSales,
        grossProfit,
        operatingExpenses: input.operatingExpenses,
        netProfit: input.netProfit,
        grossMargin: input.revenue > 0 ? Math.round((grossProfit / input.revenue) * 10000) / 100 : 0,
        netMargin: input.revenue > 0 ? Math.round((input.netProfit / input.revenue) * 10000) / 100 : 0,
      };

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
      return {
        operatingCashFlow: opCF,
        investingCashFlow: -capex,
        financingCashFlow: 0,
        netCashFlow: opCF - capex,
        openingCash: input.cash - (opCF - capex),
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
        otherIncome: 0,
        otherExpenses: 0,
        netProfit: input.netProfit,
      });
      return { steps };
    }

    case 'trends':
      return { note: 'Multi-period trend data requires historical context via API' };

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
