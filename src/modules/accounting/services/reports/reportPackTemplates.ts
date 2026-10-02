/**
 * Which sections each pack type carries, in order. Moved out of
 * `reportPackService.ts` unchanged to keep that file under the 300-line cap;
 * `reportPackService.ts` re-exports `getPackTemplate`.
 */

import type { PackSectionConfig, PackType } from './reportPackTypes';

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
