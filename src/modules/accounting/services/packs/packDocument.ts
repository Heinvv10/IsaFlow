/**
 * The pack, as a model.
 *
 * The screen, the printed PDF and the PPTX deck all rendered `section.data`
 * with their own string keys and their own `?? 0` fallbacks, which is silent:
 * a rename in reportPackService produces a plausible document full of zeros
 * with no compile error. This is the one typed shape all three read, and
 * packDocument.test.ts fails if a number appears here that is not in the pack.
 *
 * NOTHING IN THIS FILE COMPUTES A FIGURE. Every value is copied through the
 * mappers in statementRows/packMappers.ts, which are themselves copies.
 */
import type { PackSection, PackType, ReportPack } from '@/modules/accounting/services/reports/reportPackService';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import {
  packToBsDetail, packToBsTotals, packToMargins, packToTotals,
  toManagementBsRows, toManagementPandLRows,
} from '@/modules/accounting/services/reports/statementRows/packMappers';
import type { KPIScorecardItem } from '@/modules/accounting/services/reports/kpiScorecardService';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import type { PackTrendPoint } from './packTrendService';
import { isLandscapeSection, packSectionTitle } from './packSections';

export interface PackKvItem {
  label: string;
  value: number;
  format: 'money' | 'ratio' | 'pct';
}

export type PackBlock =
  | { kind: 'statement'; rows: StatementRow[] }
  | { kind: 'kv'; items: PackKvItem[] }
  | { kind: 'scorecard'; items: KPIScorecardItem[] }
  | { kind: 'waterfall'; steps: WaterfallStep[] }
  | { kind: 'trend'; points: PackTrendPoint[] }
  | { kind: 'text'; text: string };

export interface PackDocumentSection {
  type: string;
  title: string;
  landscape: boolean;
  blocks: PackBlock[];
}

export interface PackDocument {
  packType: PackType;
  companyName: string;
  period: string;
  generatedAt: string;
  sections: PackDocumentSection[];
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const CASH_FLOW_LINES: Array<[string, string]> = [
  ['Operating Cash Flow', 'operatingCashFlow'],
  ['Investing Cash Flow', 'investingCashFlow'],
  ['Financing Cash Flow', 'financingCashFlow'],
  ['Net Cash Flow', 'netCashFlow'],
  ['Opening Cash', 'openingCash'],
  ['Closing Cash', 'closingCash'],
];

function humanise(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
}

function blocksFor(section: PackSection, trend: PackTrendPoint[]): PackBlock[] {
  const d = section.data;

  switch (section.type) {
    case 'income_statement': {
      const margins = packToMargins(d);
      return [
        { kind: 'statement', rows: toManagementPandLRows(packToTotals(d)) },
        {
          kind: 'kv',
          items: [
            { label: 'Gross Margin', value: margins.grossMargin, format: 'pct' },
            { label: 'Net Margin', value: margins.netMargin, format: 'pct' },
          ],
        },
      ];
    }

    case 'balance_sheet':
      return [{ kind: 'statement', rows: toManagementBsRows(packToBsTotals(d), packToBsDetail(d)) }];

    case 'cash_flow':
      return [{
        kind: 'kv',
        items: CASH_FLOW_LINES.map(([label, key]) => ({ label, value: num(d[key]), format: 'money' as const })),
      }];

    case 'ratios':
      return [{
        kind: 'kv',
        items: Object.entries(d)
          .filter(([, v]) => typeof v === 'number')
          .map(([k, v]) => ({ label: humanise(k), value: num(v), format: 'ratio' as const })),
      }];

    case 'kpis': {
      const items = (d.scorecard as KPIScorecardItem[] | undefined) ?? [];
      return [{ kind: 'scorecard', items }];
    }

    case 'waterfall': {
      const steps = (d.steps as WaterfallStep[] | undefined) ?? [];
      return steps.length > 0
        ? [{ kind: 'waterfall', steps }]
        : [{ kind: 'text', text: 'No profit bridge for this period.' }];
    }

    case 'trends':
      return trend.length > 0
        ? [{ kind: 'trend', points: trend }]
        : [{ kind: 'text', text: 'No posted journals in the last twelve months.' }];

    case 'commentary':
      return [{ kind: 'text', text: String(d.summary ?? '') }];

    default:
      return [];
  }
}

export function buildPackDocument(pack: ReportPack, trend: PackTrendPoint[]): PackDocument {
  return {
    packType: pack.type,
    companyName: pack.companyName,
    period: pack.period,
    generatedAt: pack.generatedAt,
    sections: pack.sections.map((section) => ({
      type: section.type,
      title: packSectionTitle(section.type, section.title),
      landscape: isLandscapeSection(section.type),
      blocks: blocksFor(section, trend),
    })),
  };
}
