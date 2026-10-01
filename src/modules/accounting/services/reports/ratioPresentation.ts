/**
 * HOW A RATIO IS NAMED AND WRITTEN — one table, read by every surface.
 *
 * The engine keys its ratios in camelCase, and each surface turned the key
 * into a label its own way: the pack document and the two legacy renderers
 * split it on capitals ("Ebitda", "Roce", "Pbit Margin", "Pbt To Net
 * Interest"), the screen card did the same, and the KPI scorecard had a
 * hand-kept name list of its own. Values were worse: `toFixed(2)` on
 * everything, so a rand amount printed as "-1883824.19" beside a margin
 * printed as "25.43" with nothing saying which was a percentage.
 *
 * A `satisfies Record<RatioKey, …>` so a ratio added to the engine without a
 * name and a unit here is a compile error, not a row that quietly prints a
 * raw key in the wrong unit.
 */
import { formatDays, formatMoney, formatPctLevel, formatRatio } from '@/lib/format/money';
import type { ExtendedRatioResult } from './ratioTypes';

export type RatioKey = Exclude<keyof ExtendedRatioResult, 'notMeaningful'>;

/**
 * The unit a figure is written in.
 *   pct    a margin, a return or a rate — a LEVEL    45.0%   (never +45.0%)
 *   times  a cover or a turnover — a multiple        3.20×
 *   ratio  a proportion with no unit of its own      1.85
 *   days   a day count                               73 days
 *   money  a rand amount                             1 234 567.89
 */
export type RatioFormat = 'pct' | 'times' | 'ratio' | 'days' | 'money';

const RATIOS = {
  // Base ratios
  grossProfitMargin: { label: 'Gross Profit Margin', format: 'pct' },
  netProfitMargin: { label: 'Net Profit Margin', format: 'pct' },
  operatingProfitMargin: { label: 'Operating Profit Margin', format: 'pct' },
  currentRatio: { label: 'Current Ratio', format: 'ratio' },
  quickRatio: { label: 'Quick Ratio', format: 'ratio' },
  debtToEquity: { label: 'Debt to Equity', format: 'ratio' },
  returnOnAssets: { label: 'Return on Assets (ROA)', format: 'pct' },
  returnOnEquity: { label: 'Return on Equity (ROE)', format: 'pct' },
  debtorDays: { label: 'Debtor Days', format: 'days' },
  creditorDays: { label: 'Creditor Days', format: 'days' },
  inventoryTurnover: { label: 'Inventory Turnover', format: 'times' },
  // Profitability
  ebitda: { label: 'EBITDA', format: 'money' },
  ebitdaMargin: { label: 'EBITDA Margin', format: 'pct' },
  roce: { label: 'Return on Capital Employed (ROCE)', format: 'pct' },
  pbitMargin: { label: 'PBIT Margin', format: 'pct' },
  directMaterialMargin: { label: 'Direct Material Margin', format: 'pct' },
  // Leverage
  interestCoverage: { label: 'Interest Cover', format: 'times' },
  debtRatio: { label: 'Debt Ratio', format: 'ratio' },
  equityMultiplier: { label: 'Equity Multiplier', format: 'times' },
  // Liquidity
  cashRatio: { label: 'Cash Ratio', format: 'ratio' },
  workingCapital: { label: 'Working Capital', format: 'money' },
  operatingCashFlowRatio: { label: 'Operating Cash Flow Ratio', format: 'ratio' },
  // Efficiency
  assetTurnover: { label: 'Asset Turnover', format: 'times' },
  receivablesTurnover: { label: 'Receivables Turnover', format: 'times' },
  payablesTurnover: { label: 'Payables Turnover', format: 'times' },
  inventoryDays: { label: 'Inventory Days', format: 'days' },
  cashConversionCycle: { label: 'Cash Conversion Cycle', format: 'days' },
  netOperatingAssetTurnover: { label: 'Net Operating Asset Turnover', format: 'times' },
  // Cash flow
  freeCashFlow: { label: 'Free Cash Flow', format: 'money' },
  // Coverage
  ebitdaToNetInterest: { label: 'EBITDA to Net Interest', format: 'times' },
  pbtToNetInterest: { label: 'PBT to Net Interest', format: 'times' },
  netProfitToNetInterest: { label: 'Net Profit to Net Interest', format: 'times' },
  // Employee productivity
  revenuePerEmployee: { label: 'Revenue per Employee', format: 'money' },
  pbitPerEmployee: { label: 'PBIT per Employee', format: 'money' },
  ebitdaPerEmployee: { label: 'EBITDA per Employee', format: 'money' },
  employeeCostToRevenue: { label: 'Employee Cost to Revenue', format: 'pct' },
  employeeCostPerHead: { label: 'Employee Cost per Head', format: 'money' },
  // Returns
  dividendCover: { label: 'Dividend Cover', format: 'times' },
  retentionRate: { label: 'Retention Rate', format: 'pct' },
  effectiveTaxRate: { label: 'Effective Tax Rate', format: 'pct' },
  // DuPont
  dupontMargin: { label: 'DuPont Margin', format: 'pct' },
  dupontTurnover: { label: 'DuPont Turnover', format: 'times' },
  dupontLeverage: { label: 'DuPont Leverage', format: 'times' },
} as const satisfies Record<RatioKey, { label: string; format: RatioFormat }>;

/** The unit each ratio is written in, by key. */
export const RATIO_FORMATS = Object.fromEntries(
  Object.entries(RATIOS).map(([key, { format }]) => [key, format]),
) as { [K in RatioKey]: (typeof RATIOS)[K]['format'] };

export function isRatioKey(key: string): key is RatioKey {
  return Object.prototype.hasOwnProperty.call(RATIOS, key);
}

/**
 * A ratio key this table has no row for.
 *
 * THROWN, NOT WORKED AROUND. An unknown key used to get a label split on its
 * capitals and two decimals, or was dropped from the pack document without a
 * word — so a ratio added to the engine and missed here would print unnamed
 * in the wrong unit, or vanish from a document a client is sent. The compiler
 * catches that for the engine's own type; this catches it for a blob.
 */
export class UnknownRatioError extends Error {
  constructor(public readonly ratioKey: string) {
    super(`No name or unit is defined for the ratio '${ratioKey}' — add it to ratioPresentation.ts.`);
    this.name = 'UnknownRatioError';
  }
}

function presentationOf(key: string): { label: string; format: RatioFormat } {
  if (!isRatioKey(key)) throw new UnknownRatioError(key);
  return RATIOS[key];
}

/** The name a reader sees. @throws UnknownRatioError for a key with no row. */
export function ratioLabel(key: string): string {
  return presentationOf(key).label;
}

/** A figure in its unit, in the pack's number convention. */
export function formatRatioFigure(format: RatioFormat, value: number): string {
  switch (format) {
    // A LEVEL, so unsigned: every `pct` ratio here is a margin, a return or a
    // rate. The signed formatter is for a CHANGE — "+45.0%" on a gross margin
    // reads as growth of 45%.
    case 'pct': return formatPctLevel(value, 1);
    case 'times': return `${formatRatio(value)}×`;
    case 'ratio': return formatRatio(value);
    case 'days': return formatDays(value);
    case 'money': return formatMoney(value, { cents: true, pack: true });
  }
}

/** What a surface prints when a null ratio arrives with no reason. */
export const RATIO_NOT_MEANINGFUL = 'Not meaningful';

export interface RatioLine {
  key: string;
  label: string;
  /** The figure in its unit, or — where there is none — the reason. */
  text: string;
  /** False where `text` is a reason: the ratio could not be stated. */
  stated: boolean;
}

/**
 * One ratio as a surface prints it: its name, and its figure or the reason
 * it has none. A ratio is never both and never neither.
 */
export function ratioLine(
  key: string,
  value: number | null,
  reasons: Record<string, string>,
): RatioLine {
  const { label, format } = presentationOf(key);
  const reason = reasons[key];
  if (value === null || reason !== undefined) {
    return { key, label, text: reason ?? RATIO_NOT_MEANINGFUL, stated: false };
  }
  return { key, label, text: formatRatioFigure(format, value), stated: true };
}

/**
 * Every ratio in an engine result (or a pack's `ratios` section blob), in the
 * order it carries them. The reasons map is not itself a ratio.
 * @throws UnknownRatioError if the result carries a ratio this table has no
 *   row for — the rest is not printed without it.
 */
export function ratioLines(result: Record<string, unknown>): RatioLine[] {
  const raw = result.notMeaningful;
  const reasons = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, string>)
    : {};
  const lines: RatioLine[] = [];
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === 'number' || value === null) lines.push(ratioLine(key, value, reasons));
  }
  return lines;
}
