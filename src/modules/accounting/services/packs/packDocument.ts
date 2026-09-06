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
 * mappers in statementRows/packMappers.ts and packSectionData.ts, which are
 * themselves copies. The sections that are not statements — cash flow, KPIs,
 * the profit bridge, the ratio reasons, the commentary — read their blob
 * through packSectionData.ts's typed accessors, which THROW on a missing key
 * rather than defaulting: a rename upstream must fail the render, not print a
 * plausible statement of zeros.
 */
import type { PackSection, PackType, ReportPack } from '@/modules/accounting/services/reports/reportPackService';
import type { StatementRow } from '@/modules/accounting/services/reports/statementRows/statementModel';
import {
  packToBsDetail, packToBsTotals, packToMargins, packToTotals,
  toManagementBsRows, toManagementPandLRows,
} from '@/modules/accounting/services/reports/statementRows/packMappers';
import type { ExtendedRatioResult } from '@/modules/accounting/services/reports/reportingEngineService';
import type { KPIScorecardItem } from '@/modules/accounting/services/reports/kpiScorecardService';
import type { WaterfallStep } from '@/modules/accounting/services/reports/waterfallDataService';
import type { PackTrendPoint } from './packTrendService';
import { isLandscapeSection, isPackSectionType, packSectionTitle, type PackSectionType } from './packSections';
import {
  CASH_FLOW_FIELDS, cashFlowLabel, packToCashFlow, packToCommentary,
  packToRatioReasons, packToScorecard, packToWaterfallSteps,
} from './packSectionData';

export interface PackKvItem {
  label: string;
  /** null when the figure could not be computed — see `unavailable`. */
  value: number | null;
  format: 'money' | 'ratio' | 'pct' | 'days';
  /**
   * When set, the surface prints this text INSTEAD of the figure, exactly as
   * `KpiTile.unavailable` does on the executive dashboard. A ratio dividing by
   * non-positive equity is arithmetically meaningless (AN-07), and a pack that
   * silently omitted the row disagreed with the dashboard on the same company.
   */
  unavailable?: string;
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

/**
 * Every numeric field `calculateExtendedRatios` returns, and how it must be
 * READ. Three kinds share that one blob: true ratios and turnover/day counts
 * (bare numbers), percentages built with `pct()`, and rand amounts. Tagging
 * the lot `'ratio'` printed R4,400,000 of working capital as "4400000.00"
 * next to a current ratio of 2.32 — a renderer cannot tell them apart from
 * the value, only from the field name.
 *
 * `satisfies Record<RatioKey, ...>` is what keeps this honest: a field added
 * to `ExtendedRatioResult` is a COMPILE ERROR here, not a row that quietly
 * defaults to the wrong unit.
 */
type RatioKey = Exclude<keyof ExtendedRatioResult, 'notMeaningful'>;

export const RATIO_FORMATS = {
  // Base ratios
  grossProfitMargin: 'pct',
  netProfitMargin: 'pct',
  operatingProfitMargin: 'pct',
  currentRatio: 'ratio',
  quickRatio: 'ratio',
  debtToEquity: 'ratio',
  returnOnAssets: 'pct',
  returnOnEquity: 'pct',
  debtorDays: 'days',
  creditorDays: 'days',
  inventoryTurnover: 'ratio',
  // Profitability
  ebitda: 'money',
  ebitdaMargin: 'pct',
  roce: 'pct',
  pbitMargin: 'pct',
  directMaterialMargin: 'pct',
  // Leverage
  interestCoverage: 'ratio',
  debtRatio: 'ratio',
  equityMultiplier: 'ratio',
  // Liquidity
  cashRatio: 'ratio',
  workingCapital: 'money',
  operatingCashFlowRatio: 'ratio',
  // Efficiency
  assetTurnover: 'ratio',
  receivablesTurnover: 'ratio',
  payablesTurnover: 'ratio',
  inventoryDays: 'days',
  cashConversionCycle: 'days',
  netOperatingAssetTurnover: 'ratio',
  // Cash flow
  freeCashFlow: 'money',
  // Coverage
  ebitdaToNetInterest: 'ratio',
  pbtToNetInterest: 'ratio',
  netProfitToNetInterest: 'ratio',
  // Employee productivity
  revenuePerEmployee: 'money',
  pbitPerEmployee: 'money',
  ebitdaPerEmployee: 'money',
  employeeCostToRevenue: 'pct',
  employeeCostPerHead: 'money',
  // Returns
  dividendCover: 'ratio',
  retentionRate: 'pct',
  effectiveTaxRate: 'pct',
  // DuPont
  dupontMargin: 'pct',
  dupontTurnover: 'ratio',
  dupontLeverage: 'ratio',
} as const satisfies Record<RatioKey, PackKvItem['format']>;

/** A ratio field the map knows, whether or not the service could compute it.
 *  `null` is kept: it is a row the pack must still print, with its reason. */
const isRatioEntry = (e: [string, unknown]): e is [RatioKey, number | null] =>
  e[0] in RATIO_FORMATS && (typeof e[1] === 'number' || e[1] === null);

/** Reached only if the service nulls a ratio without recording why. */
const NOT_MEANINGFUL = 'Not meaningful';

/** Why a margin row can have no figure. `marginPct` returns null on zero or
 *  negative turnover, and dividing by a negative prints a healthy-looking
 *  POSITIVE percentage — so there is no margin to print, not a margin of 0. */
export const NO_MARGIN_REASON = 'No margin on non-positive turnover';

/**
 * One margin row. Exported because the interactive screen prints the same two
 * figures off the same section data: two call sites formatting a nullable
 * margin their own way is how one of them ends up printing "0.0%" again.
 */
export function marginKvItem(label: string, value: number | null): PackKvItem {
  return value === null
    ? { label, value: null, format: 'pct', unavailable: NO_MARGIN_REASON }
    : { label, value, format: 'pct' };
}

function humanise(key: string): string {
  return key.replace(/([A-Z])/g, ' $1').replace(/^./, (s) => s.toUpperCase());
}

/** A section type reportPackService emits that this file has no blocks for.
 *  Thrown rather than returned empty: a titled, blank page in a document a
 *  director forwards to a bank is worse than a failed render. */
export class UnknownPackSectionError extends Error {
  constructor(public readonly sectionType: string) {
    super(`No PackDocument blocks are defined for section type '${sectionType}'.`);
    this.name = 'UnknownPackSectionError';
  }
}

function blocksFor(sectionType: PackSectionType, section: PackSection, trend: PackTrendPoint[]): PackBlock[] {
  const d = section.data;

  switch (sectionType) {
    case 'income_statement': {
      const margins = packToMargins(d);
      return [
        { kind: 'statement', rows: toManagementPandLRows(packToTotals(d)) },
        {
          kind: 'kv',
          items: [
            marginKvItem('Gross Margin', margins.grossMargin),
            marginKvItem('Net Margin', margins.netMargin),
          ],
        },
      ];
    }

    case 'balance_sheet':
      return [{ kind: 'statement', rows: toManagementBsRows(packToBsTotals(d), packToBsDetail(d)) }];

    case 'cash_flow': {
      // Typed, not read by loose key: a rename upstream throws here rather
      // than producing six labelled zeros. See packSectionData.ts.
      const cashFlow = packToCashFlow(d);
      return [{
        kind: 'kv',
        items: CASH_FLOW_FIELDS.map((field) => ({
          label: cashFlowLabel(field), value: cashFlow[field], format: 'money' as const,
        })),
      }];
    }

    case 'ratios': {
      // The service's own reason, copied through — the dashboard prints this
      // same string, and a pack that dropped the row instead disagreed with it.
      const reasons = packToRatioReasons(d);
      return [{
        kind: 'kv',
        items: Object.entries(d)
          .filter(isRatioEntry)
          .map(([k, v]) => {
            const reason = reasons[k];
            return v === null || reason !== undefined
              ? { label: humanise(k), value: null, format: RATIO_FORMATS[k], unavailable: reason ?? NOT_MEANINGFUL }
              : { label: humanise(k), value: v, format: RATIO_FORMATS[k] };
          }),
      }];
    }

    case 'kpis':
      return [{ kind: 'scorecard', items: packToScorecard(d) }];

    case 'waterfall': {
      const steps = packToWaterfallSteps(d);
      return steps.length > 0
        ? [{ kind: 'waterfall', steps }]
        : [{ kind: 'text', text: 'No profit bridge for this period.' }];
    }

    // The pack's own `trends` data is a single-period snapshot; the handed-in
    // twelve-month series supersedes it and the snapshot is not read here.
    case 'trends':
      return trend.length > 0
        ? [{ kind: 'trend', points: trend }]
        : [{ kind: 'text', text: 'No posted journals in the last twelve months.' }];

    case 'commentary':
      return [{ kind: 'text', text: packToCommentary(d) }];

    default: {
      const unreachable: never = sectionType;
      throw new UnknownPackSectionError(String(unreachable));
    }
  }
}

export function buildPackDocument(pack: ReportPack, trend: PackTrendPoint[]): PackDocument {
  return {
    packType: pack.type,
    companyName: pack.companyName,
    period: pack.period,
    generatedAt: pack.generatedAt,
    sections: pack.sections.map((section) => {
      if (!isPackSectionType(section.type)) throw new UnknownPackSectionError(section.type);
      return {
        type: section.type,
        title: packSectionTitle(section.type, section.title),
        landscape: isLandscapeSection(section.type),
        blocks: blocksFor(section.type, section, trend),
      };
    }),
  };
}
